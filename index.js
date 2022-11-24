import WebTorrent from '../webtorrent/index.js'
import MemoryChunkStore from 'memory-chunk-store'
import path from 'path'
import debugFactory from 'debug'
import Torrent from '../webtorrent/lib/torrent.js'
import EventEmitter from 'events'
import * as fs from 'fs'

const debug = debugFactory('webtorrent-cli')

class WebTorrentId {
  constructor (id, torrent, opts) {
    this._id = id
    this._torrent = torrent
    this._opts = opts
    this.info = null
    this.meta = null
    this.done = false
    this.seeding = false
    this.seedPath = null
    this.seedFiles = null
  }
}

export class WebTorrentCli extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._client = new WebTorrent({
      blocklist: opts.blocklist,
      torrentPort: opts.torrentPort,
      dhtPort: opts.dhtPort,
      downloadLimit: opts.downloadLimit,
      uploadLimit: opts.uploadLimit
    })
    this._torrents = new Map()
    this._counter = 0
    this._resumeDir = opts.resumePath
    this._resumeFile = null
    this._client.on('error', err => {
      this.emit('error', err)
    })
    //this.load()
    debug('new WebTorrentCli')
  }

  get progress () {
    return this._client.progress
  }

  newTorrent (torrent, opts = {}) {
    let index = ++this._counter
    while (this._torrents.has(index)) {
      index = ++this._counter
    }
    const torrentId = new WebTorrentId(index, torrent, opts)
    this._torrents.set(index, torrentId)
    return index
  }

  getTorrentId (index) {
    if (this._torrents.has(index)) return this._torrents.get(index)
    return null
  }

  add (torrentId, opts = {}, ontorrent) {
    debug('add %s', opts)

    const convertFiles = (files) => {
      return files.map(file => {
        return {
          path: file.path,
          name: file.name,
          length: file.length,
          offset: file.offset
        }
      })
    }

    if (!opts.pieceDownload) {
      let tid
      const torrent = this._client.add(torrentId, {
        path: opts.out,
        announce: opts.announce
      }, torrent => {
        tid.meta = torrent.torrentFile
        this.store()
        if (typeof ontorrent === 'function') ontorrent(torrent)
      })
      const index = this.newTorrent(torrent, opts)
      tid = this.getTorrentId(index)
      torrent.on('infoHash', () => {
        if (opts.select) {
          torrent.so = opts.select.toString()
        }
        tid.info = torrent.infoHash
      })
      torrent.on('done', () => {
        tid.done = true
        if (opts.out && !opts.keepSeeding) {
          torrent.destroy()
          this._torrents.delete(index)
        } else {
          tid.seeding = true
          tid.seedPath = torrent.path
          tid.seedFiles = convertFiles(torrent.files)
          console.log('seeding:', torrentId.seedPath, torrentId.seedFiles)
        }
        this.store()
      })
      return index
    }

    const index = this.newTorrent(null, opts)
    let tid = this.getTorrentId(index)
    const meta = this.getMeta(torrentId, { announce: opts.announce }, (torrentFile, pieceLength) => {
      let start = opts.pieceStart ?? -1
      let end = opts.pieceEnd ?? -1
      if (start == -1 || end == -1) {
        let x = opts.btpartCount
        let y = opts.btpartIndex-1
        let part = Math.ceil(pieceLength/x)
        start = y * part
        end = start + part -1
        if (end > pieceLength - 1) end = pieceLength - 1
      }
      debug('piecedownload: %s %s', start, end)

      const torrent = this._client.add(torrentFile, {
        path: opts.out,
        announce: opts.announce,
        pieceDownload: true,
        pieceStart: start,
        pieceEnd: end
      }, torrent => {
        tid.meta = torrent.torrentFile
        this.store()
        if (typeof ontorrent === 'function') ontorrent(torrent)
      })
      tid._torrent = torrent
      torrent.on('done', () => {
        tid.done = true
        if (opts.out && !opts.keepSeeding) {
          torrent.destroy()
          this._torrents.delete(index)
        } else {
          tid.seeding = true
          tid.seedPath = torrent.path
          tid.seedFiles = convertFiles(torrent.files)
          tid.opts.pieceSeed = true
          tid.opts.pieceSeedPath = torrent.files.at(0).name
          tid.opts.torrentId = torrent.torrentFile
          console.log('seeding:', tid.seedPath, tid.seedFiles, tid.opts.pieceSeedPath)
        }
        this.store()
      })
      torrent.on('infoHash', () => {
        tid.info = torrent.infoHash
      })
      torrent.on('ready', () => {
        debug('on ready, select %s-%s', start, end)
        torrent.so = ''
        torrent.select(start, end, false)
      })
    })
    tid._torrent = meta
    return index
  }

  seed (input, opts, onseed) {
    debug('seed %s', opts)
    if (!opts.pieceSeed) {
      let torrentId
      const torrent = this._client.seed(input, {announce: opts.announce}, torrent => {
        if (torrentId) {
          torrentId.seeding = true
          torrentId.seedPath = input
          this.store()
        }
        if (typeof onseed === 'function') onseed(torrent)
      })
      const index = this.newTorrent(torrent, opts)
      torrentId = this.getTorrentId(index)
      torrent.on('infohash', () => {
        torrentId.info = torrent.infoHash
      })
      torrent.on('metadata', () => {
        torrentId.meta = torrent.torrentFile
      })
      return index
    }

    const index = this.newTorrent(null, opts)
    let torrentId = this.getTorrentId(index)
    const meta = this.getMeta(opts.torrentId, null, (torrentFile, pieceLength) => {
      let start = opts.pieceStart ?? -1
      let end = opts.pieceEnd ?? -1
      if (start == -1 || end == -1) {
        let x = opts.btpartCount
        let y = opts.btpartIndex-1
        let part = Math.ceil(pieceLength/x)
        start = y * part
        end = start + part -1
        if (end > pieceLength - 1) end = pieceLength - 1
      }
      debug('pieceseed: %s %s', start, end)

      const torrent = this._client.pieceSeed(input, torrentFile, {
        announce: opts.announce,
        pieceSeed: true,
        pieceStart: start,
        pieceEnd: end,
        pieceSeedPath: path.basename(input)
      }, torrent => {
        console.log('runPieceSeed: ontorrent')
        torrent.on('infoHash', () => {
          torrent.so = 'x'
          console.log('on infoHash:', torrent.so, torrent.files.length)
          torrentId.info = torrent.infoHash
        })
    
        torrent.on('metadata', () => {
          console.log('on metadata:', torrent.so, torrent.files.length, torrent.pieces.length)
          torrentId.meta = torrent.torrentFile
        })
      }, torrent => {
        console.log('runPieceSeed: onseed')
        torrentId.seeding = true
        torrentId.seedPath = input
        this.store()
        if (typeof onseed === 'function') onseed(torrent)
      })
      torrentId._torrent = torrent
    })
    torrentId._torrent = meta
    return index
  }

  remove (torrent, cb) {
    if (typeof torrent === 'number') {
      if (this._torrents.has(torrent)) {
        let t = this._torrents.get(torrent)
        if (!t) this._torrents.delete(torrent)
        else this.remove(this._torrents.get(torrent), cb)
      }
      let torrentId = this.getTorrentId(torrent)
      if (torrentId) {
        let t = torrentId._torrent
        this._torrents.delete(torrent)
        if (t) this._client.remove(t, null, cb)
      }
      return
    }

    if (torrent instanceof Torrent) {
      let index = 0
      for (let entry of this._torrents) {
        if (entry[1]._torrent === torrent) {
          index = entry[0]
          break
        }
      }
      if (index > 0) {
        this._torrents.delete(index)
        this._client.remove(torrent, null, cb)
      }
    }
  }

  destroy (cb) {
    this._client.destroy(cb)
    this._torrents.clear()
    this._torrents = null
    this._client = null
  }

  getMeta (torrentId, opts = {}, cb = () => {}) {
    let torrent = this._client.add(torrentId, {
      store: MemoryChunkStore,
      announce: opts ? opts.announce : null,
      mdonly: true
    })
    torrent.on('metadata', () => {
      let count = torrent.pieces.length
      let torrentFile = Buffer.from(torrent.torrentFile)
      torrent.destroy()
      debug('get meta done.')
      cb(torrentFile, count)
    })
    return torrent
  }

  store () {
    if (!this._resumeDir) return
    const resumeFile = this._resumeDir + '/' + 'webtorrent-resume-' + Date.now()
    const oldFile = this._resumeFile
    const data = JSON.stringify(this._torrents)
    fs.writeFile(resumeFile, data, err => {
      if (err) {
        console.log('writeFile error:', resumeFile, err)
        return
      }
      console.log('writeFile success:', resumeFile)
      this._resumeFile = resumeFile
      if (oldFile) {
        fs.rm(oldFile, err => {
          if (err) {
            console.log('rm error:', oldFile, err.name, err.message)
          }
        })
      }
    })
  }

  load () {
    console.log('load:', this._resumeDir)
    if (!this._resumeDir) return
    let st = fs.statSync(this._resumeDir, {throwIfNoEntry: false})
    if (!st) {
      fs.mkdir(this._resumeDir, { recursive: true }, err => {
        if (err) {
          console.log('mkdir error:', this._resumeDir, err.name, err.message)
        }
      })
      return
    }
    if (!st.isDirectory()) {
      console.log('path %s is not a directory', this._resumeDir)
      return
    }
    const names = fs.readdirSync(this._resumeDir)
    if (names.length == 0) return
    let resumeFile = null
    let path
    names.forEach(name => {
      if (name.startsWith('webtorrent-resume-')) {
        path = this._resumeDir + '/' + name
        st = fs.statSync(path, {throwIfNoEntry: false})
        if (st && st.isFile()) {
          if (!resumeFile) resumeFile = name
          else if (resumeFile < name) resumeFile = name
        }
      }
    });
    if (resumeFile) {
      path = this._resumeDir + '/' + resumeFile
      const data = fs.readFileSync(path)
      try {
        const obj = JSON.parse(data)
        if (obj instanceof Map) {
          for (let entry of obj) {
            if (entry[1] instanceof WebTorrentId) {
              this.resume(obj)
            }
          }
        }
      } catch (e) {
        console.log('Parse resume file error:', e.name, e.message)
      }
    }
  }

  resume (torrentId) {
    console.log('resume:', torrentId._id, torrentId.info)
    if (torrentId.seeding) {
      if (torrentId.seedPath) {
        if (torrentId.seedFiles) this.seed(torrentId.seedFiles, torrentId.opts)
        else this.seed(torrentId.seedPath, torrentId.opts)
      }
    } else if (!torrentId.done) {
      this.add(torrentId.meta, torrentId.opts)
    }
  }
}
