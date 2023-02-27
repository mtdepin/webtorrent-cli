import fs from 'fs'
import cp from 'child_process'
import parseTorrent from 'parse-torrent'
import spawn from 'cross-spawn'
import test from 'tape'
import { resolve } from 'path'
import { rejects } from 'assert'

const CMD_PATH = new URL('../bin/cmd.js', import.meta.url).pathname
//const CMD = `node ${CMD_PATH}`
const CURL = `curl --unix-socket /var/run/webtorrent_http.sock http://localhost -d`
const TORRENT_PATH = new URL('../node_modules', import.meta.url).pathname

test('Add torrents', t => {
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

  async function createTorrent (file) {
    const child = spawn('node', [CMD_PATH, 'create', file])
    child.on('error', err => { t.fail(err) })

    const chunks = []
    child.stdout.on('data', chunk => {
      chunks.push(chunk)
    })
    const onEnd = new Promise((resolve, rejects) => {
      child.stdout.on('end', () => {
        const buf = Buffer.concat(chunks)
        const parsedTorrent = parseTorrent(Buffer.from(buf, 'binary'))
        console.log(file, parsedTorrent.infoHash)
        if (typeof parsedTorrent.infoHash === 'string') {
          resolve(parsedTorrent.infoHash)
        } else {
          rejects(new Error('parse error'))
        }
      })
    })
    let infoHash = await onEnd
    console.log('createTorrent done.', file)

    const r = cp.execSync(`${CURL} 'add ${infoHash} --keep-seeding --set-timeout 6000000'`)
    console.log('exec:', infoHash, r.toString())
  }

  files.forEach(file => createTorrent(file))
  t.end()
})