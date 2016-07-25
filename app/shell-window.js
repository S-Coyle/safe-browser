import { setup as setupUI } from './shell-window/ui'
import history from './lib/fg/history-api'
import sitedata from './lib/fg/sitedata-api'
import dat from './lib/fg/dat-api'

// setup UI
setupUI()

// expose some APIs to the window, for debugging with devtools
window.beaker = {
  history,
  sitedata,
  dat
}