// EE2's loadClientStrings(lang): the data dir's client_strings.mjs is an ES module; import it.
'use strict'
const path = require('path'), { pathToFileURL } = require('url')
let dataDir = null
function setDataDir(d) { dataDir = d }
async function loadClientStrings(lang) { return (await import(pathToFileURL(path.join(dataDir, lang, 'client_strings.mjs')).href)).default }
module.exports = { loadClientStrings, setDataDir }
