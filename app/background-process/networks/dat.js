import { app, ipcMain, shell } from 'electron'
import through2Concurrent from 'through2-concurrent'
import { Readable } from 'stream'
import concat from 'concat-stream'
import emitStream from 'emit-stream'
import EventEmitter from 'events'
import pump from 'pump'
import multicb from 'multicb'
import from2 from 'from2'

// db modules
import hyperdrive from 'hyperdrive'
var hypercoreMessages = require('hypercore/lib/messages') // TODO remove when https://github.com/mafintosh/hypercore/pull/36 merges
import level from 'level'
import subleveldown from 'subleveldown'

// network modules
import dns from 'dns'
import url from 'url'
import hyperdriveArchiveSwarm from 'hyperdrive-archive-swarm'
import electronWebrtc from 'electron-webrtc'

// file modules
import path from 'path'
import raf from 'random-access-file'
import mkdirp from 'mkdirp'
import identify from 'identify-filetype'
import mime from 'mime'
import bdatVersionsFile from 'bdat-versions-file'
import getFolderSize from 'get-folder-size'
import yazl from 'yazl'

// io modules
import rpc from 'pauls-electron-rpc'
import manifest from '../../lib/rpc-manifests/dat'
import log from '../../log'

// constants
// =

// special files
export const MANIFEST_FILENAME = 'manifest.json'
export const VFILENAME = '.bdat/versions.json.log'

// 64 char hex
export const HASH_REGEX = /[0-9a-f]{64}/i

// where are the given archive's files kept
const ARCHIVE_FILEPATH = archiveOrKey => path.join(dbPath, 'Archives', bufToStr(archiveOrKey.key || archiveOrKey))

// globals
// =

var dbPath // path to the hyperdrive folder
var db // level instance
var archiveMetaDb // archive metadata sublevel
var subscribedArchivesDb // subcribed archives sublevel
var ownedArchivesDb // owned archives sublevel
var drive // hyperdrive instance
var wrtc // webrtc instance

var archives = {} // key -> archive
var swarms = {} // key -> swarm
var ownedArchives = new Set() // set of owned archives
var subscribedArchives = new Set() // set of current subscriptions
var archivesEvents = new EventEmitter()

// config default mimetype
mime.default_type = 'text/plain'

// exported API
// =

export function setup () {
  // open databases
  dbPath = path.join(app.getPath('userData'), 'Hyperdrive')
  mkdirp.sync(path.join(dbPath, 'Archives')) // make sure the folders exist
  db = level(dbPath)
  archiveMetaDb = subleveldown(db, 'archive-meta', { valueEncoding: 'json' })
  subscribedArchivesDb = subleveldown(db, 'subscribed-archives', { valueEncoding: 'json' })
  ownedArchivesDb = subleveldown(db, 'owned-archives', { valueEncoding: 'json' })
  drive = hyperdrive(db)

  // create webrtc
  wrtc = electronWebrtc()
  wrtc.on('error', err => log('[WRTC]', err))

  // load all owned archives and start swarming them
  ownedArchivesDb.createKeyStream().on('data', key => {
    ownedArchives.add(key)
    createArchive(new Buffer(key, 'hex'), { sparse: false })
    swarm(key)
  })

  // load all subscribed archives and start swarming them
  subscribedArchivesDb.createKeyStream().on('data', key => {
    subscribedArchives.add(key)
    createArchive(new Buffer(key, 'hex'), { sparse: false }) // TODO do we want sparsemode?
    swarm(key)
  })

  // wire up the rpc
  rpc.exportAPI('dat', manifest, rpcMethods)
}

export function createArchive (key, opts) {
  opts = opts || {}
  var sparse = (opts.sparse === false) ? false : true // by default, only download files when they're requested

  // validate key
  if (key !== null && (!Buffer.isBuffer(key) || key.length != 32))
    return

  // NOTE this only works on live archives
  var archive = drive.createArchive(key, {
    live: true,
    sparse: sparse,

    // TODO 
    // do we want to use the FS, or leveldb, to store files?
    // if the `file` opt isnt specified, we're using leveldb
    // leveldb may perform worse overall, but it lets use deduplicate across archives
    // however, FS lets us open the archive in explorer
    // -prf     
    file: name => raf(path.join(ARCHIVE_FILEPATH(archive), name)) // currently: using FS
  })
  return archive
}

export function cacheArchive (archive) {
  archives[archive.key.toString('hex')] = archive
}

export function getArchive (key) {
  var [keyBuf, keyStr] = bufAndStr(key)

  // fetch or create
  if (keyStr in archives)
    return archives[keyStr]
  return (archives[keyStr] = createArchive(keyBuf))
}

export function getArchiveMeta (key, cb) {
  key = bufToStr(key)

  // pull data from meta db
  archiveMetaDb.get(key, (err, meta) => {
    meta = meta || {}

    // give sane defaults
    // (just in case the metadata record came from an older build, and has holes in it)
    meta = Object.assign({
      name: 'Untitled',
      author: false,
      version: '0.0.0',
      mtime: 0,
      size: 0,
      isDownloading: false,
      isSharing: (key in swarms),
      isOwner: ownedArchives.has(key),
      isSubscribed: subscribedArchives.has(key)
    }, meta)

    // pull some live data
    var archive = archives[key]
    if (archive) {
      // TODO this definition is wrong. waiting on a solution in hyperdrive. -prf
      /*meta.isDownloading = 
        (archive.metadata._downloaded < archive.metadata.blocks) ||
        (archive.content && archive.content._downloaded < archive.content.blocks)*/
    }

    cb(null, meta)
  })
}

// read metadata for the archive, and store it in the meta db
export function updateArchiveMeta (archive) {
  var key = archive.key.toString('hex')
  var done = multicb({ pluck: 1, spread: true })

  // open() just in case (we need .blocks)
  archive.open(() => {

    // read the archive metafiles
    readManifest(archive, done())
    readVFile(archive, done())

    // calculate the size on disk
    var sizeCb = done()
    getFolderSize(ARCHIVE_FILEPATH(archive), (err, size) => {
      sizeCb(null, size)
    })

    done((err, manifest, vfile, size) => {
      manifest = manifest || {}
      var { name, description, author, homepage_url } = manifest
      var version = (vfile) ? vfile.current : false
      var mtime = Date.now() // use our local update time
      size = size || 0

      // write the record
      var update = { name, description, author, homepage_url, version, mtime, size }
      log('[DAT] Writing meta', update)
      archiveMetaDb.put(key, update, err => {
        if (err)
          log('[DAT] Error while writing archive meta', key, err)

        // emit event
        update.key = key
        archivesEvents.emit('update-archive', update)
      })
    })
  })
}

// create a new archive
export function createNewArchive () {
  var archive = createArchive(null)
  var key = archive.key.toString('hex')
  ownedArchives.add(key)
  ownedArchivesDb.put(key, {})
  return archive
}

// duplicate an archive
export function clone (key, cb) {
  if (!HASH_REGEX.test(key))
    return cb(new Error('Invalid archive key'))

  // list the archive contents
  var srcArchive = getArchive(key)
  srcArchive.list((err, entries) => {
    if (err)
      return cb(err)

    // remove duplicates
    var entriesMap = {}
    entries.forEach(e => entriesMap[e.name] = e)
    entries = Object.keys(entriesMap).map(name => entriesMap[name])

    // download all
    var done = multicb()
    entries.forEach(entry => {
      srcArchive.download(entry, done())
    })
    done(err => {
      if (err)
        return cb(err)

      // create the new archive, and copy all files
      var dstArchive = createNewArchive()
      var done = multicb()
      entries.forEach(entry => {
        pump(
          srcArchive.createFileReadStream(entry),
          dstArchive.createFileWriteStream(entry),
          done()
        )
      })
      done(err => {
        if (err)
          return cb(err)
        cb(null, dstArchive.key.toString('hex'))
      })
    })
  })
}

// un/subscribe to archives
export function subscribe (key, subscribed, cb) {
  if (subscribed) {
    subscribedArchives.add(key)
    subscribedArchivesDb.put(key, true, () => cb())
  } else {
    subscribedArchives.delete(key)
    subscribedArchivesDb.del(key, false, () => cb())
  }
}

// put the archive into the network, for upload and download
// (this is kind of like saying, "go live")
export function swarm (key) {
  var [keyBuf, keyStr] = bufAndStr(key)

  // fetch
  if (keyStr in swarms)
    return swarms[keyStr]

  // create
  log('[DAT] Swarming archive', keyStr)
  var archive = getArchive(key)
  var s = hyperdriveArchiveSwarm(archive, { wrtc })
  swarms[keyStr] = s

  // hook up events
  s.on('connection', (peer, type) => log('[DAT] Connection', peer.id.toString('hex'), 'from', type.type))
  archive.open(err => {
    if (err)
      return log('[DAT] Error opening archive for swarming', keyStr, err)

    if (archive.metadata) {
      archive.metadata.on('download-finished', () => {
        log('[DAT] Metadata download finished', keyStr)
        updateArchiveMeta(archive)
      })
    }
    if (archive.content) {
      archive.content.on('download-finished', () => {
        log('[DAT] Content download finished', keyStr)
        updateArchiveMeta(archive)
      })
    }
  })
  return s
}

export function resolveName (name, cb) {
  // is it a hash?
  if (HASH_REGEX.test(name))
    return cb(null, name)

  // do a dns lookup
  log('[DAT] DNS TXT lookup for name:', name)
  dns.resolveTxt(name, (err, records) => {
    log('[DAT] DNS TXT results for', name, err || records)
    if (err)
      return cb(err)

    // scan the txt records for a dat URI
    for (var i=0; i < records.length; i++) {
      if (records[i][0].indexOf('dat://') === 0) {
        var urlp = url.parse(records[i][0])
        if (HASH_REGEX.test(urlp.host)) {
          log('[DAT] DNS resolved', name, 'to', urlp.host)
          return cb(null, urlp.host)
        }
        log('[DAT] DNS TXT record failed:', records[i], 'Must be a dat://{hash} url')
      }
    }

    cb({ code: 'ENOTFOUND' })
  })
}

export function getAndIdentifyEntry (archive, entry, cb) {
  var rs = archive.createFileReadStream(entry)
  rs.on('error', cb)
  rs.pipe(concat(data => {
    // try to identify the type by the buffer contents
    var mimeType
    var identifiedExt = identify(data)
    if (identifiedExt)
      mimeType = mime.lookup(identifiedExt)
    if (mimeType)
      log('[DAT] Identified entry mimetype as', mimeType)
    else {
      // fallback to using the entry name
      mimeType = mime.lookup(entry.name)
      log('[DAT] Assumed mimetype from entry name', mimeType)
    }

    cb(null, { data: data, mimeType: mimeType })
  }))
}

export function createZipFileStream (archive) {
  var zipfile = new yazl.ZipFile()

  // list files
  archive.list((err, entries) => {
    if (err)
      return onerror(err)

    // remove duplicates
    var entriesMap = {}
    entries.forEach(e => entriesMap[e.name] = e)
    var entriesKeys = Object.keys(entriesMap)

    // create listing stream
    var listingStream = from2.obj((size, next) => {
      if (entriesKeys.length === 0)
        return next(null, null)
      next(null, entriesMap[entriesKeys.shift()])
    })

    // create the writestream
    var zipWriteStream = listingStream
      .pipe(through2Concurrent.obj({ maxConcurrency: 3 }, (entry, enc, cb) => {
        // files only
        if (entry.type != 'file')
          return cb()

        // pipe each entry into the zip
        log('[DAT] Zipfile writing', JSON.stringify(entry))
        var fileReadStream = archive.createFileReadStream(entry)
        zipfile.addReadStream(fileReadStream, entry.name)
        fileReadStream.on('error', onerror)
        fileReadStream.on('end', cb)
      }))
    zipWriteStream.on('data', ()=>{})
    zipWriteStream.on('error', onerror)
    zipWriteStream.on('end', () => {
      log('[DAT] Zipfile creation done')
      zipfile.end()
    })
  })

  // on error, push to the output stream
  function onerror (e) {
    log('[DAT] Zipfile error', e)
    zipfile.outputStream.emit('error', e)
  }

  // log output stream errors
  zipfile.outputStream.on('error', e => log('[DAT] Zipfile write error', e))

  return zipfile.outputStream
}

// rpc exports
// =

function streamFetchMeta (key, enc, cb) {
  if (Buffer.isBuffer(key))
    key = key.toString('hex')

  // get archive meta
  getArchiveMeta(key, (err, meta) => {
    meta = meta || {}
    meta.key = key
    cb(null, meta)
  })
}

var rpcMethods = {
  archives (cb) {
    // list the archives, fetch meta, and send back
    drive.core.list()
      .pipe(through2Concurrent.obj({ maxConcurrency: 100 }, streamFetchMeta))
      .pipe(concat(list => cb(null, list)))
      .on('error', cb)
  },

  ownedArchives (cb) {
    // list the owned archives, fetch meta, and send back
    var s = new Readable({ objectMode: true, read(){} })
    s.pipe(through2Concurrent.obj({ maxConcurrency: 100 }, streamFetchMeta))
      .pipe(concat(list => cb(null, list)))
      .on('error', cb)

    for (let key of ownedArchives) {
      s.push(key)
    }
    s.push(null)
  },

  subscribedArchives (cb) {
    // list the subbed, archives, fetch meta, and send back
    subscribedArchivesDb.createKeyStream()
      .pipe(through2Concurrent.obj({ maxConcurrency: 100 }, streamFetchMeta))
      .pipe(concat(list => cb(null, list)))
      .on('error', cb)
  },

  createFileWriteStream (archiveKey, entry) {
    // get the archive
    var archive = getArchive(archiveKey)
    if (!archive)
      throw new Error('Invalid archive key')
    if (!entry || (!entry.name || typeof entry.name != 'string'))
      throw new Error('Entry obj with .name is required')

    // create write stream
    return archive.createFileWriteStream(entry)
  },

  archiveInfo (key, cb) {
    // get the archive
    var archive = getArchive(key)
    if (!archive)
      return cb(new Error('Invalid archive key'))

    // fetch archive data
    var done = multicb({ pluck: 1, spread: true })
    archive.list(done())
    readManifest(archive, done())
    readVFile(archive, done())
    readReadme(archive, done())
    done((err, entries, manifest, versionHistory, readme) => {
      if (err)
        return cb(err)
      // give sane defaults
      manifest = manifest || {}
      versionHistory = versionHistory || bdatVersionsFile.create()

      // some other meta
      var isApp = entries && !!entries.find(e => e.name == 'index.html')
      var isSubscribed = subscribedArchives.has(key)
      var isOwner = archive.owner

      cb(null, { key, entries, manifest, readme, versionHistory, isApp, isSubscribed, isOwner })
    })
  },

  archivesEventStream () {
    return emitStream(archivesEvents)
  },

  openInExplorer(key, cb) {
    shell.showItemInFolder(ARCHIVE_FILEPATH(key))
    cb()
  },

  createNewArchive(cb) {
    cb(null, createNewArchive().key.toString('hex'))
  },
  clone,
  subscribe
}

// internal methods
// =

// helpers to pull file data from an archive
function readArchiveFile (archive, name, cb) {
  archive.lookup(name, (err, entry) => {
    if (!entry)
      return cb()

    var rs = archive.createFileReadStream(entry)
    rs.pipe(concat(data => cb(null, data)))
    rs.on('error', e => cb(e))
  })
}
function readManifest (archive, cb) {
  readArchiveFile(archive, MANIFEST_FILENAME, (err, data) => {
    if (!data)
      return cb()

    // parse manifest
    try {
      var manifest = JSON.parse(data.toString())
      cb(null, manifest)
    } catch (e) { cb() }
  })
}
function readVFile (archive, cb) {
  readArchiveFile(archive, VFILENAME, (err, data) => {
    if (!data)
      return cb(null, bdatVersionsFile.create())

    // parse vfile
    data = data.toString()
    bdatVersionsFile.parse(data, (err, vfile) => {
      cb(err, vfile)
    })
  })
}
function readReadme (archive, cb) {
  // we need case-insensitive lookup, so .lookup() wont work
  var entries = archive.list({live: false})
  var entry = null

  entries.on('data', function (data) {
    var name = (''+(data.name||'')).toLowerCase()
    if (name == 'readme.md')
      entry = data
  })

  entries.on('error', lookupDone)
  entries.on('close', lookupDone)
  entries.on('end', lookupDone)

  function lookupDone () {
    if (!entry) return cb()

    // read file
    var rs = archive.createFileReadStream(entry)
    rs.pipe(concat(data => cb(null, data.toString())))
    rs.on('error', e => cb(e))
  }
}

// get buffer and string version of value
function bufAndStr (v) {
  if (Buffer.isBuffer(v))
    return [v, v.toString('hex')]
  return [new Buffer(v, 'hex'), v]
}

// convert to string, if currently a buffer
function bufToStr (v) {
  if (Buffer.isBuffer(v))
    return v.toString('hex')
  return v
}