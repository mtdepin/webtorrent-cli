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
    this._storing = false
    this._loading = false
    this._loadCount = 0
    this._storePending = false
    this._client.on('error', err => {
      this.emit('error', err)
    })
    this.on('store', () => {
      debug('got store')
      this.store()
    })
    this.load()
    debug('new WebTorrentCli')
  }

  get progress () {
    return this._client.progress
  }

  get torrents () {
    let data = []
    for (let entry of this._torrents) {
      let torrentId = entry[1]
      let progress = 0
      if (torrentId.seeding) progress = 1
      else if (!torrentId.done && torrentId._torrent) progress = torrentId._torrent.progress
      data.push({
        index: torrentId._id,
        infohash: torrentId.info,
        done: torrentId.done,
        seeding: torrentId.seeding,
        progress: progress,
      })
    }
    return data
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
        if (opts.saveTorrent) {
          const torrentFilePath = `${torrent.path}/${torrent.infoHash}.torrent`
          fs.writeFile(torrentFilePath, torrent.torrentFile, (err) => {
            if (err) console.log('write torrent file error', torrentFilePath, err)
          })
          console.log('save torrent', torrentFilePath)
        }
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
      torrent.on('close', () => {
        if (this._torrents.has(index)) this._torrents.delete(index)
        console.log('close:', index)
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
        tid.info = torrent.infoHash
        tid.meta = torrent.torrentFile
        this.store()
        if (opts.saveTorrent) {
          const torrentFilePath = `${torrent.path}/${torrent.infoHash}.torrent`
          fs.writeFile(torrentFilePath, torrent.torrentFile, (err) => {
            if (err) console.log('write torrent file error', torrentFilePath, err)
          })
          console.log('save torrent', torrentFilePath)
        }
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
      torrent.on('ready', () => {
        debug('on ready, select %s-%s', start, end)
        torrent.so = ''
        torrent.select(start, end, false)
      })
      torrent.on('close', () => {
        if (this._torrents.has(index)) this._torrents.delete(index)
        console.log('close:', index)
        this.store()
      })
    })
    tid._torrent = meta
    return index
  }

  seed (input, opts, onseed) {
    debug('seed %s', opts)
    console.log('seed:', input.length, input)
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
      torrent.on('metadata', () => {
        torrentId.info = torrent.infoHash
        torrentId.meta = torrent.torrentFile
      })
      torrent.on('close', () => {
        if (this._torrents.has(index)) this._torrents.delete(index)
        console.log('close:', index)
        this.store()
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
        })
    
        torrent.on('metadata', () => {
          console.log('on metadata:', torrent.so, torrent.files.length, torrent.pieces.length)
          torrentId.info = torrent.infoHash
          torrentId.meta = torrent.torrentFile
        })
        torrent.on('close', () => {
          if (this._torrents.has(index)) this._torrents.delete(index)
          console.log('close:', index)
          this.store()
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

  resumeData () {
    let data = []
    for (let entry of this._torrents) {
      let torrentId = entry[1]
      if (torrentId.done && !torrentId.seeding) continue
      data.push({
        index: torrentId._id,
        info: torrentId.info,
        meta: JSON.stringify(torrentId.meta),
        seeding: torrentId.seeding,
        seedpath: torrentId.seedPath,
        seedfiles: torrentId.seedFiles,
        opts: torrentId._opts,
      })
    }
    return data
  }

  parseResumeData (raw) {
    let data = []
    let a = JSON.parse(raw)
    a.map(t => {
      data.push({
        index: t.index,
        info: t.info,
        meta: Buffer.from(JSON.parse(t.meta).data),
        seeding: t.seeding,
        seedpath: t.seedpath,
        seedfiles: t.seedfiles,
        opts: t.opts,
      })
    })
    return data
  }

  store () {
    if (!this._resumeDir) return
    if (this._loading) return
    if (this._storing) {
      this._storePending = true
      return
    }
    this._storing = true
    const resumeFile = this._resumeDir + '/' + 'webtorrent-resume-' + Date.now()
    const oldFile = this._resumeFile
    const data = JSON.stringify(this.resumeData())
    console.log('store: torrents', this._torrents)
    fs.writeFile(resumeFile, data, err => {
      this._storing = false
      if (this._storePending) {
        this._storePending = false
        this.emit('store')
      }
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
    this._loading = true
    let st = fs.statSync(this._resumeDir, {throwIfNoEntry: false})
    if (!st) {
      fs.mkdir(this._resumeDir, { recursive: true }, err => {
        if (err) {
          console.log('mkdir error:', this._resumeDir, err.name, err.message)
        }
      })
      this._loading = false
      return
    }
    if (!st.isDirectory()) {
      console.log('path %s is not a directory', this._resumeDir)
      this._loading = false
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
        const torrents = this.parseResumeData(data)
        this._loadCount = torrents.length
        torrents.map(t => {
          this.resume(t, () => {
            --this._loadCount
            if (this._loadCount === 0) this._loading = false
          })
        })
        this._resumeFile = path
        console.log('Resume torrents from file:', path)
      } catch (e) {
        console.log('Parse resume file error:', e.name, e.message)
        this._loading = false
      }
    }
  }

  resume (torrentId, cb) {
    console.log('resume:', torrentId.index, torrentId.info)
    if (torrentId.seeding) {
      if (torrentId.seedpath) {
        if (torrentId.seedfiles) {
          let input = []
          torrentId.seedfiles.map(f => {
            input.push(torrentId.seedpath + '/' + f.path)
          })
          this.seed(input, torrentId.opts, cb)
        } else this.seed(torrentId.seedpath, torrentId.opts, cb)
      }
    } else {
      this.add(torrentId.meta, torrentId.opts, cb)
    }
  }
}
