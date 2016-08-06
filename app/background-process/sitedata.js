import { app, ipcMain } from 'electron'
import sqlite3 from 'sqlite3'
import path from 'path'
import url from 'url'
import rpc from 'pauls-electron-rpc'
import manifest from './api-manifests/sitedata'
import { setupDatabase } from '../lib/bg/sqlite-tools'
import log from '../log'

// globals
// =
var db
var migrations
var waitForSetup

// exported methods
// =

export function setup () {
  // open database
  var dbPath = path.join(app.getPath('userData'), 'SiteData')
  db = new sqlite3.Database(dbPath)
  waitForSetup = setupDatabase(db, migrations, '[SITEDATA]')

  // wire up RPC
  rpc.exportAPI('beakerSitedata', manifest, {
    get: getSendOrigin,
    set: setSendOrigin,
    getOtherOrigin: get,
    setOtherOrigin: set
  })
}

export function set (url, key, value, cb) {
  waitForSetup(() => {
    var origin = extractOrigin(url)
    if (!origin)
      return cb()
    db.run(`
      INSERT OR REPLACE
        INTO sitedata (origin, key, value)
        VALUES (?, ?, ?)
    `, [origin, key, value], cb)
  })
}

export function get (url, key, cb) {
  waitForSetup(() => {
    var origin = extractOrigin(url)
    if (!origin)
      return cb()
    db.get(`SELECT value FROM sitedata WHERE origin = ? AND key = ?`, [origin, key], (err, res) => {
      if (err)
        return cb(err)
      cb(null, res && res.value)
    })
  })
}

function setSendOrigin (key, value, cb) {
  return set(this.sender.getURL(), key, value, cb)
}

function getSendOrigin (key, cb) {
  return get(this.sender.getURL(), key, cb)
}

// internal methods
// =

function extractOrigin (originURL) {
  var urlp = url.parse(originURL)
  if (!urlp || !urlp.host || !urlp.protocol)
    return
  return (urlp.protocol + urlp.host + (urlp.port || ''))
}

migrations = [
  // version 1
  function (cb) {
    db.exec(`
      CREATE TABLE sitedata(
        origin NOT NULL,
        key NOT NULL,
        value
      );
      CREATE UNIQUE INDEX sitedata_origin_key ON sitedata (origin, key);
      PRAGMA user_version = 1;
    `, cb)
  }
]