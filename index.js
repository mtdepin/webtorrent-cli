import WebTorrent from '../webtorrent/index.js'
import MemoryChunkStore from 'memory-chunk-store'
import path from 'path'
import debugFactory from 'debug'
import Torrent from '../webtorrent/lib/torrent.js'

const debug = debugFactory('webtorrent-cli')

export class WebTorrentCli {
  constructor (opts = {}) {
    this._client = new WebTorrent({
      blocklist: opts.blocklist,
      torrentPort: opts.torrentPort,
      dhtPort: opts.dhtPort,
      downloadLimit: opts.downloadLimit,
      uploadLimit: opts.uploadLimit
    })
    this._torrents = new Map()
    this._counter = 0
    this._client.on('error', err => {
      this.emit('error', err)
    })
    debug('new WebTorrentCli')
  }

  get progress () {
    return this._client.progress
  }

  newTorrent (torrent) {
    let index = ++this._counter
    this._torrents.set(index, torrent)
    return index
  }

  add (torrentId, opts = {}, ontorrent) {
    debug('add %s', opts)
    if (!opts.pieceDownload) {
      const torrent = this._client.add(torrentId, {
        path: opts.out,
        announce: opts.announce
      }, torrent => {
        if (typeof ontorrent === 'function') ontorrent(torrent)
      })
      torrent.on('infoHash', () => {
        if (opts.select) {
          torrent.so = opts.select.toString()
        }
      })
      torrent.on('done', () => {
        if (opts.out && !opts.keepSeeding) {
          torrent.destroy()
        }
      })
      return this.newTorrent(torrent)
    }

    const index = this.newTorrent(null)
    const meta = this.getMeta(torrentId, { announce: opts.announce }, (torrentFile, pieceLength) => {
      let x = opts.btpartCount
      let y = opts.btpartIndex-1
      let part = Math.ceil(pieceLength/x)
      let start = y * part
      let end = start + part -1
      if (end > pieceLength - 1) end = pieceLength - 1

      const torrent = this._client.add(torrentFile, {
        path: opts.out,
        announce: opts.announce,
        pieceDownload: true,
        pieceStart: start,
        pieceEnd: end
      }, torrent => {
        if (typeof ontorrent === 'function') ontorrent(torrent)
      })
      this._torrents.set(index, torrent)
      torrent.on('done', () => {
        if (opts.out && !opts.keepSeeding) {
          torrent.destroy()
        }
      })
      torrent.on('ready', () => {
        debug('on ready, select %s-%s', start, end)
        torrent.so = ''
        torrent.select(start, end, false)
      })
    })
    this._torrents.set(index, meta)
    return index
  }

  seed (input, opts, onseed) {
    debug('seed %s', opts)
    if (!opts.pieceSeed) {
      const torrent = this._client.seed(input, {announce: opts.announce}, torrent => {
        if (typeof onseed === 'function') onseed(torrent)
      })
      return this.newTorrent(torrent)
    }

    const index = this.newTorrent(null)
    const meta = this.getMeta(opts.torrentId, null, (torrentFile, pieceLength) => {
      let x = opts.btpartCount
      let y = opts.btpartIndex-1
      let part = Math.ceil(pieceLength/x)
      let start = y * part
      let end = start + part -1
      if (end > pieceLength - 1) end = pieceLength - 1
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
        })
      }, torrent => {
        console.log('runPieceSeed: onseed')
        if (typeof onseed === 'function') onseed(torrent)
      })
      this._torrents.set(index, torrent)
    })
    this._torrents.set(index, meta)
    return index
  }

  remove (torrent, cb) {
    if (typeof torrent === 'number') {
      if (this._torrents.has(torrent)) {
        let t = this._torrents.get(torrent)
        if (!t) this._torrents.delete(torrent)
        else this.remove(this._torrents.get(torrent), cb)
      }
      return
    }

    if (torrent instanceof Torrent) {
      let index = 0
      for (let entry of this._torrents) {
        if (entry[1] === torrent) {
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
}
