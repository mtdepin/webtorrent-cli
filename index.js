import WebTorrent from '../webtorrent/index.js'
import MemoryChunkStore from 'memory-chunk-store'
import debugFactory from 'debug'
import Torrent from '../webtorrent/lib/torrent.js'
import EventEmitter from 'events'
import * as fs from 'fs'
import { nanoid } from 'nanoid'
import log4js from 'log4js'

const debug = debugFactory('webtorrent-cli')

log4js.configure({
  appenders: {
    WebTorrentCli: { type: 'file', filename: 'webtorrent.log' },
  },
  categories: {
    default: { appenders: ['WebTorrentCli'], level: 'debug' },
  },
})
const logger = log4js.getLogger()

const TORRENT_TIMEOUT = 600000

class WebTorrentId {
  constructor (id, torrent, opts = {}) {
    this._id = id
    this._torrent = torrent
    this._opts = Object.assign({}, opts)
    if (this._opts.pieceRange) {
      this._opts.pieceRange = [...opts.pieceRange]
    }
    this.info = null
    this.meta = null
    this.done = false
    this.seeding = false
    this.seedPath = null
    this.seedFiles = null
    this.path = null
    this.appendOpts = null
    this.paused = false
    this.pausing = false
    this.timer = null
  }

  destroy () {
    this._torrent = null
    this._opts = null
    this.info = null
    this.meta = null
    this.seedPath = null
    this.seedFiles = null
    this.path = null
    this.appendOpts = null
    this.timer = null
  }
}

export class WebTorrentCli extends EventEmitter {
  constructor (opts = {}) {
    super()
    console.log('WebTorrentCli:', opts)
    let tracker
    if (opts.rtcConfig) {
      let a = JSON.parse(opts.rtcConfig)
      if (a) tracker = { rtcConfig: a }
    }
    this._client = new WebTorrent({
      blocklist: opts.blocklist,
      torrentPort: opts.torrentPort,
      dhtPort: opts.dhtPort,
      downloadLimit: opts.downloadLimit,
      uploadLimit: opts.uploadLimit,
      tracker: tracker
    })
    this._torrents = new Map()
    this._counter = 0
    this._resumeDir = opts.resumePath
    this._resumeFile = null
    this._storing = false
    this._loading = false
    this._loadCount = 0
    this._storePending = false
    this.destroyed = false
    this._client.on('error', err => {
      this.emit('error', err)
    })
    this.on('store', () => {
      debug('got store')
      this.store()
    })
    this.load(() => {
      this.emit('loaded')
    })
    debug('new WebTorrentCli')
  }

  get progress () {
    return this._client.progress
  }

  get torrents () {
    let data = []
    for (let entry of this._torrents) {
      let torrentId = entry[1]
      const progress = torrentId._torrent ? torrentId._torrent.progress : 0
      data.push({
        index: torrentId._id,
        infohash: torrentId.info,
        done: torrentId.done,
        seeding: torrentId.seeding,
        progress: progress,
        paused: torrentId.paused,
        seedfiles: torrentId.seedFiles
      })
    }
    return data
  }

  newTorrent (torrent, opts = {}) {
    if (opts.resumeIndex) {
      let tId = this.getTorrentId(opts.resumeIndex)
      if (!tId) {
        console.log('newTorrent: resume index not found', opts.resumeIndex)
        return null
      }
      tId._torrent = torrent
      if (tId.paused !== true) {
        console.log('newTorrent: WARN: paused not true', tId)
      }
      tId.paused = false
      tId.seeding = false
      return opts.resumeIndex
    }

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

  _onTorrentClose (index) {
    if (this._torrents.has(index)) {
      const cTid = this._torrents.get(index)
      if (cTid.pausing) {
        return
      }
      const torrent = cTid._torrent
      if (torrent) {
        torrent.removeAllListeners('infoHash')
        torrent.removeAllListeners('metadata')
        torrent.removeAllListeners('done')
        torrent.removeAllListeners('download')
        torrent.removeAllListeners('close')
        cTid._torrent = null
      }
      this._torrents.delete(index)
      if (cTid.timer) {
        clearTimeout(cTid.timer)
        cTid.timer = null
      }
      cTid.destroy()
    }
    console.log('close:', index)
    this.store()
  }

  _setTimeout (torrentId, torrent, timeout) {
    console.log('_setTimeout:', torrentId.info, timeout)
    const f = () => {
      torrentId.timer = setTimeout(() => {
        this.pause(torrentId._id, err => {
          if (err) {
            console.log('torrent timeout: pause failed', torrentId.info, err)
          }
        })
      }, timeout)
    }

    f()
    if (!torrent) return
    torrent.on('download', (_bytes) => {
      clearTimeout(torrentId.timer)
      f()
    })
  }

  add (torrentId, opts = {}, ontorrent) {
    debug('add %s', opts)
    console.log('add:', opts)

    const convertFiles = (files) => {
      return files.map(file => {
        return file.path
      })
    }

    if (!opts.pieceDownload) {
      let tid
      const torrent = this._client.add(torrentId, {
        path: opts.out,
        fixPath: true,
        announce: opts.announce
      }, torrent => {
        if (torrent.destroyed) return
        tid.meta = torrent.torrentFile
        tid.path = torrent.path
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
      if (index) tid = this.getTorrentId(index)
      if (!tid) return null
      tid.info = torrentId
      this._setTimeout(tid, torrent, opts.timeout || TORRENT_TIMEOUT)
      torrent.on('infoHash', () => {
        if (opts.select) {
          torrent.so = opts.select.toString()
        }
        tid.info = torrent.infoHash
      })
      torrent.on('done', () => {
        tid.done = true
        if (tid.timer) {
          clearTimeout(tid.timer)
          tid.timer = null
        }
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
        this._onTorrentClose(index)
      })
      return index
    }

    const index = this.newTorrent(null, opts)
    let tid = index !== null ? this.getTorrentId(index) : null
    if (!tid) return null
    tid.info = torrentId
    const meta = this.getMeta(torrentId, { announce: opts.announce }, (torrentFile, pieceLength) => {
      let start, end
      if (opts.btpartCount && opts.btpartIndex) {
        let x = opts.btpartCount
        let y = opts.btpartIndex-1
        let part = Math.ceil(pieceLength/x)
        start = y * part
        end = start + part -1
        if (end > pieceLength - 1) end = pieceLength - 1
      } else if ((typeof opts.pieceStart === 'number') && (typeof opts.pieceEnd === 'number')) {
        start = opts.pieceStart
        end = opts.pieceEnd
      }
      debug('piecedownload: %s %s', start, end)

      if (tid.timer) {
        clearTimeout(tid.timer)
        tid.timer = null
      }

      const torrent = this._client.add(torrentFile, {
        path: opts.out,
        fixPath: true,
        announce: opts.announce,
        pieceDownload: true,
        pieceStart: start,
        pieceEnd: end,
        pieceRange: opts.pieceRange
      }, torrent => {
        if (torrent.destroyed) return
        tid.info = torrent.infoHash
        tid.meta = torrent.torrentFile
        tid.path = torrent.path
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
      this._setTimeout(tid, torrent, opts.timeout || TORRENT_TIMEOUT)
      torrent.on('done', () => {
        tid.done = true
        if (tid.timer) {
          clearTimeout(tid.timer)
          tid.timer = null
        }
        if (opts.out && !opts.keepSeeding) {
          torrent.destroy()
          this._torrents.delete(index)
          console.log('torrent done:', index)
        } else {
          tid.seeding = true
          tid.seedPath = torrent.path
          tid.seedFiles = convertFiles(torrent.files)
          tid._opts.pieceSeed = true
          tid._opts.torrentId = torrent.torrentFile
          tid._opts.pieceRange = [...torrent._pieceRange]
          if (tid._opts.pieceStart) tid._opts.pieceStart = null
          if (tid._opts.pieceEnd) tid._opts.pieceEnd = null
          if (tid._opts.btpartCount) tid._opts.btpartCount = null
          if (tid._opts.btpartIndex) tid._opts.btpartIndex = null
          console.log('seeding:', tid.seedPath, tid.seedFiles, tid._opts)
        }
        this.store()
      })
      torrent.on('close', () => {
        this._onTorrentClose(index)
      })
    })
    tid._torrent = meta
    this._setTimeout(tid, null, opts.timeout || TORRENT_TIMEOUT)
    return index
  }

  seed (input, opts, onseed) {
    debug('seed %s', opts)
    console.log('seed:', input, opts)
    if (!opts.pieceSeed) {
      let torrentId
      const torrent = this._client.seed(input, {announce: opts.announce}, torrent => {
        if (torrentId) {
          torrentId.seeding = true
          torrentId.seedPath = torrent.path
          torrentId.seedFiles = torrent.files.map(f => f.path)
          this.store()
        }
        if (typeof onseed === 'function') onseed(torrent)
      })
      const index = this.newTorrent(torrent, opts)
      if (index) torrentId = this.getTorrentId(index)
      if (!torrentId) return null
      torrent.on('metadata', () => {
        torrentId.info = torrent.infoHash
        torrentId.meta = torrent.torrentFile
      })
      torrent.on('close', () => {
        this._onTorrentClose(index)
      })
      return index
    }

    const index = this.newTorrent(null, opts)
    let torrentId = index !== null ? this.getTorrentId(index) : null
    if (!torrentId) return null
    const meta = this.getMeta(opts.torrentId, null, (torrentFile, pieceLength) => {
      let start, end
      if (opts.btpartCount && opts.btpartIndex) {
        let x = opts.btpartCount
        let y = opts.btpartIndex-1
        let part = Math.ceil(pieceLength/x)
        start = y * part
        end = start + part -1
        if (end > pieceLength - 1) end = pieceLength - 1
      } else if ((typeof opts.pieceStart === 'number') && (typeof opts.pieceEnd === 'number')) {
        start = opts.pieceStart
        end = opts.pieceEnd
      }
      debug('pieceseed: %s %s', start, end)

      const torrent = this._client.pieceSeed(input, torrentFile, {
        path: opts.out,
        fixPath: (typeof opts.fixPath === 'boolean') ? opts.fixPath : true,
        announce: opts.announce,
        pieceSeed: true,
        pieceStart: start,
        pieceEnd: end,
        pieceRange: opts.pieceRange
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
          this._onTorrentClose(index)
        })
      }, torrent => {
        console.log('runPieceSeed: onseed')
        torrentId.seeding = true
        torrentId.seedPath = torrent.path
        torrentId.seedFiles = torrent.files.map(f => f.path)
        this.store()
        if (typeof onseed === 'function') onseed(torrent)
      })
      torrentId._torrent = torrent
    })
    torrentId._torrent = meta
    return index
  }

  append (torrent, pieceStart, pieceEnd, path) {
    let torrentId
    console.log('append:', torrent, typeof torrent)
    if (typeof torrent === 'number') {
      torrentId = this.getTorrentId(torrent)
    } else if (torrent instanceof WebTorrentId) {
      torrentId = torrent
    }
    if (torrentId) {
      let t = torrentId._torrent
      console.log('append:', torrentId.info, pieceStart, pieceEnd, path)
      if (!t.metadata) {
        t.once('metadata', () => {
          this.append(torrent, pieceStart, pieceEnd, path)
        })
        return
      }
      if (!torrentId.appendOpts) torrentId.appendOpts = []
      torrentId.appendOpts.push({
        pieceStart: pieceStart,
        pieceEnd: pieceEnd,
        path: path
      })
      console.log('append: push appendOpts', torrentId.appendOpts, torrentId._opts.pieceRange)
      t.addPiece(pieceStart, pieceEnd, path)
      torrentId.done = false
      console.log('append: final', torrentId._opts.pieceRange)
      this.store()

      t.on('done', () => {
        console.log('torrent done:', torrentId.info)
        torrentId.seeding = true
        torrentId.seedPath = t.path
        torrentId.seedFiles = t.files.map(f => f.path)
        torrentId._opts.pieceSeed = true
        torrentId._opts.torrentId = t.torrentFile
        torrentId._opts.pieceRange = [...t._pieceRange]
        if (torrentId._opts.pieceStart) torrentId._opts.pieceStart = null
        if (torrentId._opts.pieceEnd) torrentId._opts.pieceEnd = null
        if (torrentId._opts.btpartCount) torrentId._opts.btpartCount = null
        if (torrentId._opts.btpartIndex) torrentId._opts.btpartIndex = null
        this.store()
      })
    }
  }

  remove (torrent, cb, opts = {}) {
    const rmdir = (path) => {
      console.log('removeTorrent', path)
      fs.rm(path, { recursive: true, force: true }, err => {
        if (err) console.log('removeTorrent error:', err, path)
      })
    }

    if (typeof torrent === 'number') {
      let torrentId = this.getTorrentId(torrent)
      if (torrentId) {
        let t = torrentId._torrent
        let torrentPath = torrentId.path || torrentId.seedPath
        console.log('remove:', opts, torrentPath)
        this._torrents.delete(torrent)
        if (t) {
          this._client.remove(t, null, cb)
        } else {
          this._onTorrentClose(torrentId._id)
        }
        if (opts.removeTorrent && typeof torrentPath === 'string') {
          rmdir(torrentPath)
        }
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
        this.remove(index, cb, opts)
      }
    }
  }

  pause (torrent, cb) {
    console.log('pause', torrent)
    if (typeof torrent === 'number') {
      let torrentId = this.getTorrentId(torrent)
      if (torrentId) {
        if (torrentId.paused) return true
        let t = torrentId._torrent
        if (t) {
          torrentId.pausing = true
          this._client.remove(t, null, err => {
            if (err) {
              console.log('pause error:', err)
            } else {
              torrentId.paused = true
              torrentId._torrent = null
              console.log('pause success.', torrentId)
              this.store()
            }
            cb(err)
            torrentId.pausing = false
          })
        } else {
          console.log('pause: torrent is null', torrentId)
        }
        return true
      }
    }
    return false
  }

  destroy (cb, opts = {}) {
    const rmdir = (path) => {
      console.log('removeTorrent', path)
      fs.rm(path, { recursive: true, force: true }, err => {
        if (err) console.log('removeTorrent error:', err, path)
      })
    }

    this.store()
    this.destroyed = true
    this._client.removeAllListeners('error')
    this._client.destroy(cb)
    if (opts.removeTorrent) {
      let torrentPath
      for (let entry of this._torrents) {
        torrentPath = entry[1].path
        if (typeof torrentPath === 'string') rmdir(torrentPath)
      }
    }
    this._torrents.clear()
    this._torrents = null
    this._client = null
    this.removeAllListeners('store')
    this._resumeDir = null
    this._resumeFile = null
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
      torrent.removeAllListeners('metadata')
      torrent.removeAllListeners('download')
      torrent.destroy()
      debug('get meta done.')
      cb(torrentFile, count)
    })
    return torrent
  }

  resumeData () {
    if (this.destroyed) return null
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
        appendOpts: torrentId.appendOpts,
        paused: torrentId.paused
      })
    }
    return data
  }

  parseResumeData (raw) {
    let data = []
    let a = JSON.parse(raw)
    a.map(t => {
      let opts = t.opts || {}
      if (opts.torrentId && 'data' in opts.torrentId) {
        opts.torrentId = Buffer.from(opts.torrentId.data)
      }
      data.push({
        index: t.index,
        info: t.info,
        meta: (t.meta && t.meta !== 'null') ? Buffer.from(JSON.parse(t.meta).data) : null,
        seeding: t.seeding,
        seedpath: t.seedpath,
        seedfiles: t.seedfiles,
        opts: opts,
        appendOpts: t.appendOpts,
        paused: t.paused
      })
    })
    return data
  }

  store () {
    console.log('store:', this._resumeDir, this._loading, this.destroyed, this._storing, this._storePending)
    if (!this._resumeDir || this.destroyed) return
    if (this._storing || this._loading) {
      this._storePending = true
      return
    }
    this._storing = true
    const resumeFile = this._resumeDir + '/' + 'webtorrent-resume-' + Date.now()
    const oldFile = this._resumeFile
    const data = JSON.stringify(this.resumeData())
    if (!data) return
    console.log('store: torrents', this._torrents.size)
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

  load (cb) {
    console.log('load:', this._resumeDir)
    if (!this._resumeDir) {
      cb()
      return
    }
    this._loading = true
    let st = fs.statSync(this._resumeDir, {throwIfNoEntry: false})
    if (!st) {
      fs.mkdir(this._resumeDir, { recursive: true }, err => {
        if (err) {
          console.log('mkdir error:', this._resumeDir, err.name, err.message)
        }
      })
      this._loading = false
      cb()
      return
    }
    if (!st.isDirectory()) {
      console.log('path %s is not a directory', this._resumeDir)
      this._loading = false
      cb()
      return
    }
    const names = fs.readdirSync(this._resumeDir)
    if (names.length == 0) {
      this._loading = false
      cb()
      return
    }
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

    const resetPending = () => {
      this._loading = false
      if (this._storePending) {
        this._storePending = false
        this.store()
      }
      cb()
    }

    if (resumeFile) {
      path = this._resumeDir + '/' + resumeFile
      const data = fs.readFileSync(path)
      try {
        const torrents = this.parseResumeData(data)
        this._loadCount = torrents.length
        console.log('loadCount', this._loadCount)
        if (this._loadCount === 0) {
          resetPending()
        } else {
          torrents.map(t => {
            if (t.paused) {
              --this._loadCount
              console.log('-loadCount', this._loadCount)
              let index = this.newTorrent(null, t.opts)
              let torrentId = this.getTorrentId(index)
              torrentId.info = t.info
              torrentId.meta = t.meta
              torrentId.seeding = t.seeding
              torrentId.seedPath = t.seedpath
              torrentId.seedFiles = t.seedfiles
              torrentId.path = t.path
              torrentId.appendOpts = t.appendOpts
              torrentId.paused = true
              console.log('Paused torrent:', torrentId)
              if (this._loadCount === 0) resetPending()
            } else {
              this.resume(t, () => {
                --this._loadCount
                console.log('-loadCount', this._loadCount)
                if (this._loadCount === 0) resetPending()
              })
            }
          })
        }
        this._resumeFile = path
        console.log('Resume torrents from file:', path)
      } catch (e) {
        console.log('Parse resume file error:', e.name, e.message)
        logger.error('Parse resume file error:', e.name, e.message)
        resetPending()
      }
    } else {
      resetPending()
    }
  }

  resume (torrentId, cb) {
    console.log('resume:', torrentId)
    if (typeof torrentId === 'number') {
      let tId = this.getTorrentId(torrentId)
      if (tId) {
        if (!tId.paused) return
        this.resume(tId, cb)
      } else {
        console.log('resume error: torrent not found', torrentId)
      }
      return
    }

    let seedOp = true
    let appendOp = true
    const callback = () => {
      console.log('resume callback:', torrentId.info, torrentId.appendOpts)
      if (appendOp && torrentId.appendOpts) {
        torrentId.appendOpts.forEach(opts => {
          let pieceRange = torrentId.opts ? torrentId.opts.pieceRange : (torrentId._opts ? torrentId._opts.pieceRange : null)
          if (pieceRange) {
            let r = pieceRange.find(range => {
              return Math.max(range.pieceStart, opts.pieceStart) <= Math.min(range.pieceEnd, opts.pieceEnd)
            })
            if (r) return
          }
          this.append(torrentId.index, opts.pieceStart, opts.pieceEnd, opts.path)
        })
      }
      if (seedOp && (typeof cb === 'function')) cb()
    }

    let opts, seedpath, seedfiles
    if (torrentId.paused) {
      if (torrentId instanceof WebTorrentId) {
        opts = Object.assign({}, torrentId._opts)
        opts.resumeIndex = torrentId._id
        if (torrentId.seeding) {
          seedpath = torrentId.seedPath
          seedfiles = torrentId.seedFiles
          if (opts.out) opts.out = null
        }
      } else {
        console.log('resume error: should be WebTorrentId', torrentId)
        return
      }
    } else {
      opts = torrentId.opts ? Object.assign({}, torrentId.opts) : {}
      seedpath = torrentId.seedpath
      seedfiles = torrentId.seedfiles
    }

    if (torrentId.seeding) {
      if (seedpath) {
        let st = fs.statSync(seedpath, {throwIfNoEntry: false})
        if (!st) {
          console.log('resume error: seedpath not exist', seedpath)
          appendOp = false
          callback()
          return
        }
        if (seedfiles) {
          let seedFileExist = true
          seedfiles.forEach(f => {
            if (!seedFileExist) return
            st = fs.statSync(seedpath + '/' + f, {throwIfNoEntry: false})
            if (!st) {
              console.log('resume error: seedFiles not exist', f)
              seedFileExist = false
            }
          })
          if (!seedFileExist) {
            appendOp = false
            callback()
            return
          }
          if (!opts.out) {
            opts.out = seedpath
            opts.fixPath = false
          }
          if (!opts.pieceSeed) {
            seedfiles = seedpath + '/' + seedfiles.at(0)
          }
          this.seed(seedfiles, opts, callback)
        } else this.seed(seedpath, opts, callback)
      } else {
        if (typeof cb === 'function') cb()
      }
    } else {
      seedOp = false
      this.add(torrentId.meta ? torrentId.meta : torrentId.info, opts, callback)
      if (typeof cb === 'function') cb()
    }
  }
}

export class MultiWebTorrentCli extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._opts = opts
    this.clients = new Map()
    this._saveDir = opts.savePath
    this._resumeDir = opts.resumePath
    if (!this._resumeDir && this._saveDir) {
      this._resumeDir = this._saveDir + '/resume'
    }
    this._announce = opts.announce
    this._loadCount = 0
    this.load(() => {
      this.emit('loaded')
    })
  }

  get torrents() {
    let data = []
    for (let entry of this.clients) {
      const wtcId = entry[0]
      const client = entry[1]
      const ts = client.torrents
      ts.forEach(t => {
        data.push({
          clinet: wtcId,
          index: t.index,
          infohash: t.infohash,
          done: t.done,
          seeding: t.seeding,
          progress: t.progress,
          paused: t.paused,
          seedfiles: t.seedfiles
        })
      })
    }
    return data
  }

  newClient (wtcId) {
    const id = wtcId ? wtcId : nanoid()
    let opts = Object.assign({}, this._opts)
    if (this._resumeDir) {
      opts.resumePath = this._resumeDir + '/' + id
    }
    let c = new WebTorrentCli(opts)
    this.clients.set(id, c)
    c.on('error', err => {
      console.log('Error:', err.message || err)
      logger.error('Error:', err.message || err)
    })
    c.on('loaded', () => {
      --this._loadCount
      if (this._loadCount === 0) {
        this.emit('loaded')
      }
    })
    return c
  }

  getClient (wtcId) {
    if (wtcId) {
      if (this.clients.has(wtcId)) return this.clients.get(wtcId)
      else return null
    }
    const maxClientTorrents = 10
    for (let c of this.clients.values()) {
      if (c._torrents.size < maxClientTorrents) return c
    }
    
    return this.newClient()
  }

  add (torrentId, opts = {}, ontorrent) {
    const client = this.getClient()
    if (!opts.out && this._saveDir) opts.out = this._saveDir
    if (!opts.announce && this._announce) opts.announce = this._announce
    client.add(torrentId, opts, ontorrent)
  }

  seed (input, opts, onseed) {
    const client = this.getClient()
    if (!opts.announce && this._announce) opts.announce = this._announce
    client.seed(input, opts, onseed)
  }

  load (cb) {
    if (!this._resumeDir) {
      cb()
      return
    }
    let st = fs.statSync(this._resumeDir, {throwIfNoEntry: false})
    if (!st) {
      fs.mkdir(this._resumeDir, { recursive: true }, err => {
        if (err) {
          console.log('mkdir error:', this._resumeDir, err.name, err.message)
        }
      })
      cb()
      return
    }
    if (!st.isDirectory()) {
      console.log('path %s is not a directory', this._resumeDir)
      cb()
      return
    }
    const names = fs.readdirSync(this._resumeDir)
    if (names.length == 0) {
      cb()
      return
    }
    let path
    this._loadCount = names.length
    names.forEach(name => {
      if (name.length > 20) {
        path = this._resumeDir + '/' + name
        st = fs.statSync(path, {throwIfNoEntry: false})
        if (st && st.isDirectory()) {
          this.newClient(name)
        } else {
          --this._loadCount
        }
      } else {
        --this._loadCount
      }
    });
    if (this._loadCount === 0) cb()
  }
}