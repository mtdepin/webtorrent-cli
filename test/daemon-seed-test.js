import fs from 'fs'
import cp from 'child_process'
import test from 'tape'

const CMD_PATH = new URL('../bin/cmd.js', import.meta.url).pathname
//const CMD = `node ${CMD_PATH}`
const CURL = `curl --unix-socket /var/run/webtorrent_http.sock http://localhost -d`
const TORRENT_PATH = new URL('../node_modules', import.meta.url).pathname

test('Seed torrents', t => {
  let files = []
  const travel = (path) => {
    if (files.length > 20) return
    const dirents = fs.readdirSync(path, { withFileTypes: true })
    dirents.forEach(dirent => {
      if (dirent.isDirectory()) {
        travel(`${path}/${dirent.name}`)
      } else if (dirent.isFile()) {
        files.push(`${path}/${dirent.name}`)
      }
    })
  }
  travel(TORRENT_PATH)
  console.log(files)
  t.ok(files.length > 0)

  files.forEach(file => {
    const r = cp.execSync(`${CURL} 'seed ${file} --set-timeout 6000000'`)
    console.log('exec:', file, r.toString())
  })
  t.end()
})