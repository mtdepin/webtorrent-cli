#!/usr/bin/env node
import chalk from 'chalk'
import cp from 'child_process'
import createTorrent from 'create-torrent'
import ecstatic from 'ecstatic'
import fs from 'fs'
import http from 'http'
import inquirer from 'inquirer'
import mime from 'mime'
import moment from 'moment'
import networkAddress from 'network-address'
import parseTorrent from 'parse-torrent'
import path from 'path'
import MemoryChunkStore from 'memory-chunk-store'
import prettierBytes from 'prettier-bytes'
import stripIndent from 'common-tags/lib/stripIndent/index.js'
import vlcCommand from 'vlc-command'
import WebTorrent from '../../webtorrent/index.js'
import { WebTorrentCli, MultiWebTorrentCli } from '../index.js'
import Yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import open from 'open'
import net from 'node:net'

const { version: webTorrentCliVersion } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)))
const webTorrentVersion = WebTorrent.VERSION

const yargs = Yargs()

// Group options into sections (used in yargs configuration)
const options = {
  streaming: {
    airplay: { desc: 'Apple TV', type: 'boolean' },
    chromecast: { desc: 'Google Chromecast', defaultDescription: 'all' },
    dlna: { desc: 'DLNA', type: 'boolean' },
    mplayer: { desc: 'MPlayer', type: 'boolean' },
    mpv: { desc: 'MPV', type: 'boolean' },
    omx: { desc: 'OMX', defaultDescription: 'hdmi' },
    vlc: { desc: 'VLC', type: 'boolean' },
    iina: { desc: 'IINA', type: 'boolean' },
    smplayer: { desc: 'SMPlayer', type: 'boolean' },
    xbmc: { desc: 'XBMC', type: 'boolean' },
    stdout: { desc: 'Standard out (implies --quiet)', type: 'boolean' }
  },
  simple: {
    o: { alias: 'out', desc: 'Set download destination', type: 'string', requiresArg: true },
    s: { alias: 'select', desc: 'Select specific file in torrent', defaultDescription: 'List files' },
    i: { alias: 'interactive-select', desc: 'Interactively select specific file in torrent', type: 'boolean' },
    t: { alias: 'subtitles', desc: 'Load subtitles file', type: 'string', requiresArg: true }
  },
  advanced: {
    p: { alias: 'port', desc: 'Change the http server port', type: 'number', default: 8000, requiresArg: true },
    b: { alias: 'blocklist', desc: 'Load blocklist file/url', type: 'string', requiresArg: true },
    a: { alias: 'announce', desc: 'Tracker URL to announce to', type: 'string', requiresArg: true },
    q: { alias: 'quiet', desc: 'Don\'t show UI on stdout', type: 'boolean' },
    d: { alias: 'download-limit', desc: 'Maximum download speed in kB/s', type: 'number', requiresArg: true, default: -1, defaultDescription: 'unlimited' },
    u: { alias: 'upload-limit', desc: 'Maximum upload speed in kB/s', type: 'number', requiresArg: true, default: -1, defaultDescription: 'unlimited' },
    pip: { desc: 'Enter Picture-in-Picture if supported by the player', type: 'boolean' },
    verbose: { desc: 'Show torrent protocol details', type: 'boolean' },
    playlist: { desc: 'Open files in a playlist if supported by the player', type: 'boolean' },
    'player-args': { desc: 'Add player specific arguments (see example)', type: 'string', requiresArg: true },
    'torrent-port': { desc: 'Change the torrent seeding port', defaultDescription: 'random', type: 'number', requiresArg: true },
    'dht-port': { desc: 'Change the dht port', defaultDescription: 'random', type: 'number', requiresArg: true },
    'not-on-top': { desc: 'Don\'t set "always on top" option in player', type: 'boolean' },
    'keep-seeding': { desc: 'Don\'t quit when done downloading', type: 'boolean' },
    'no-quit': { desc: 'Don\'t quit when player exits', type: 'boolean' },
    quit: { hidden: true, default: true },
    'on-done': { desc: 'Run script after torrent download is done', type: 'string', requiresArg: true },
    'on-exit': { desc: 'Run script before program exit', type: 'string', requiresArg: true },
    'piece-length': { desc: 'Piece length', type: 'number', requiresArg: true },
    'piece-select': { desc: 'Select specific pieces in torrent', defaultDescription: 'List pieces range' },
    'btpart-count': { desc: 'BT pieces part count', type: 'number', requiresArg: true },
    'btpart-index': { desc: 'BT pieces part index', type: 'number', requiresArg: true },
    'torrent-id' : { desc: 'Torrent file', type: 'string', requiresArg: true },
    'resume-path' : { desc: 'Resume file path', type: 'string', requiresArg: true },
    'save-path' : { desc: 'Save file path', type: 'string', requiresArg: true },
    'rtc-config': { desc: 'tracker rtc config', type: 'string', requiresArg:true },
    'announce-auth': { desc: 'Tracker URL announce auth', type: 'string', requiresArg:true },
    'save-torrent': { desc: 'save torrent file', type: 'boolean' },
    'disable-dht': { desc: 'disable DHT', type: 'boolean' },
    'disable-lsd': { desc: 'disable LSD', type: 'boolean' },
    'profiler': { desc: 'enable profiler', type: 'boolean' }
  }
}

const commands = [
  { command: ['download [torrent-ids...]', '$0'], desc: 'Download a torrent', handler: (args) => { processInputs(args.torrentIds, runDownload) } },
  { command: 'downloadmeta <torrent-ids...>', desc: 'Download metadata of torrent', handler: (args) => { processInputs(args.torrentIds, runDownloadMeta) } },
  { command: 'seed <inputs...>', desc: 'Seed a file or a folder', handler: (args) => { processInputs(args.inputs, runSeed) } },
  { command: 'pieceseed <inputs...>', desc: 'Seed pieces from a file or a folder', handler: (args) => { runPieceSeed(args.inputs) } },
  { command: 'create <input>', desc: 'Create a .torrent file', handler: (args) => { runCreate(args.input) } },
  { command: 'piecedownload <input>', desc: 'Download Pieces from torrent', handler: (args) => { runPieceDownload(args.input) } },
  { command: 'info <torrent-id>', desc: 'Show torrent information', handler: (args) => { runInfo(args.torrentId) } },
  { command: 'daemon', desc: 'Run daemon', handler: () => { runDaemon() } },
  { command: 'version', desc: 'Show version information', handler: () => yargs.showVersion('log') },
  { command: 'help', desc: 'Show help information' } // Implicitly calls showHelp, as a result middleware is not executed
]

// All command line arguments in one place. (stuff gets added at runtime, e.g. vlc path and omx jack)
const playerArgs = {
  vlc: ['', '--play-and-exit', '--quiet'],
  iina: ['/Applications/IINA.app/Contents/MacOS/iina-cli', '--keep-running'],
  mpv: ['mpv', '--really-quiet', '--loop=no'],
  mplayer: ['mplayer', '-really-quiet', '-noidx', '-loop', '0'],
  smplayer: ['smplayer', '-close-at-end'],
  omx: [
    'lxterminal', '-e',
    'omxplayer', '-r',
    '--timeout', '60',
    '--no-ghost-box', '--align', 'center', '-o'
  ]
}

let client, href, server, serving, playerName, subtitlesServer, drawInterval, argv
let expectedError = false
let gracefullyExiting = false
let torrentCount = 1

process.title = 'WebTorrent'

process.on('exit', code => {
  if (code === 0 || expectedError) return // normal exit
  if (code === 130) return // intentional exit with Control-C

  console.log(chalk`\n{red UNEXPECTED ERROR:} If this is a bug in WebTorrent, report it!`)
  console.log(chalk`{green OPEN AN ISSUE:} https://github.com/webtorrent/webtorrent-cli/issues\n`)
  console.log(`DEBUG INFO: webtorrent-cli ${webTorrentCliVersion}, webtorrent ${webTorrentVersion}, node ${process.version}, ${process.platform} ${process.arch}, exit ${code}`)
})

process.on('SIGINT', gracefulExit)
process.on('SIGTERM', gracefulExit)

yargs
  .wrap(Math.min(100, yargs.terminalWidth()))
  .scriptName('webtorrent')
  .locale('en')
  .fail((msg, err) => { console.log(chalk`\n{red Error:} ${msg || err}`); process.exit(1) })
  .usage(
    fs.readFileSync(new URL('ascii-logo.txt', import.meta.url), 'utf-8')
      .split('\n')
      .map(line => chalk`{bold ${line.substring(0, 20)}}{red ${line.substring(20)}}`)
      .join('\n')
      .concat('\n',
        stripIndent`
          Usage:
            webtorrent [command] <torrent-id> [options]
    
          Examples:
            webtorrent download "magnet:..." --vlc
            webtorrent "magnet:..." --vlc --player-args="--video-on-top --repeat"
    
          Default output location:
            * when streaming: Temp folder
            * when downloading: Current directory
    
          Specify <torrent-id> as one of:
            * magnet uri
            * http url to .torrent file
            * filesystem path to .torrent file
            * info hash (hex string)\n\n
        `)
  )
yargs
  .command(commands)
  .options(options.streaming).group(Object.keys(options.streaming), 'Options (streaming): ')
  .options(options.simple).group(Object.keys(options.simple).concat(['help', 'version']), 'Options (simple): ')
  .options(options.advanced).group(Object.keys(options.advanced), 'Options (advanced)')

// Yargs callback order: middleware(callback) -> command(callback) -> yargs.parse(callback)
yargs.middleware(init)

yargs
  .strict()
  .help('help', 'Show help information')
  .version('version', 'Show version information', `${webTorrentCliVersion} (${webTorrentVersion})`)
  .alias({ help: 'h', version: 'v' })
  .parse(hideBin(process.argv), { startTime: Date.now() })

function init (_argv) {
  argv = _argv
  if ((argv._.length === 0 && !argv.torrentIds) || argv._[0] === 'version') {
    return
  }

  playerArgs.omx.push(typeof argv.omx === 'string' ? argv.omx : 'hdmi')

  if (process.env.DEBUG) {
    playerArgs.vlc.push('--extraintf=http:logger', '--verbose=2', '--file-logging', '--logfile=vlc-log.txt')
  }
  if (process.env.DEBUG || argv.stdout) {
    enableQuiet()
  }

  const selectedPlayers = Object.keys(argv).filter(v => Object.keys(options.streaming).includes(v))
  playerName = selectedPlayers.length === 1 ? selectedPlayers[0] : null

  if (argv.subtitles) {
    const subtitles = JSON.stringify(argv.subtitles)

    playerArgs.vlc.push(`--sub-file=${subtitles}`)
    playerArgs.mplayer.push(`-sub ${subtitles}`)
    playerArgs.mpv.push(`--sub-file=${subtitles}`)
    playerArgs.omx.push(`--subtitles ${subtitles}`)
    playerArgs.smplayer.push(`-sub ${subtitles}`)

    subtitlesServer = http.createServer(ecstatic({
      root: path.dirname(argv.subtitles),
      showDir: false,
      cors: true
    }))
  }

  if (argv.pip) {
    playerArgs.iina.push('--pip')
  }

  if (!argv.notOnTop) {
    playerArgs.vlc.push('--video-on-top')
    playerArgs.mplayer.push('-ontop')
    playerArgs.mpv.push('--ontop')
    playerArgs.smplayer.push('-ontop')
  }

  if (argv.downloadLimit > 0) {
    argv.downloadLimit = argv.d = argv['download-limit'] = argv.downloadLimit * 1024
  }

  if (argv.uploadLimit > 0) {
    argv.uploadLimit = argv.u = argv['upload-limit'] = argv.uploadLimit * 1024
  }

  if (argv.onDone) {
    argv.onDone = argv['on-done'] = argv.onDone.split(' ')
  }

  if (argv.onExit) {
    argv.onExit = argv['on-exit'] = argv.onExit.split(' ')
  }

  if (playerName && argv.playerArgs) {
    playerArgs[playerName].push(...argv.playerArgs.split(' '))
  }

  // Trick to keep scrollable history.
  if (!['create', 'info'].includes(argv._[0]) && !argv.quiet) {
    console.log('\n'.repeat(process.stdout.rows))
    console.clear()
  }

  if (argv.rtcConfig) {
    let rtcConfig
    try {
      rtcConfig = fs.readFileSync(argv.rtcConfig)
    } catch (err) {
      return errorAndExit(err)
    }
    argv.rtcConfig = rtcConfig
  }
}

function runInfo (torrentId) {
  let parsedTorrent

  try {
    parsedTorrent = parseTorrent(torrentId)
  } catch (err) {
    // If torrent fails to parse, it could be a filesystem path, so don't consider it
    // an error yet.
  }

  if (!parsedTorrent || !parsedTorrent.infoHash) {
    try {
      parsedTorrent = parseTorrent(fs.readFileSync(torrentId))
    } catch (err) {
      return errorAndExit(err)
    }
  }

  delete parsedTorrent.info
  delete parsedTorrent.infoBuffer
  delete parsedTorrent.infoHashBuffer

  const output = JSON.stringify(parsedTorrent, undefined, 2)
  if (argv.out) {
    fs.writeFileSync(argv.out, output)
  } else {
    process.stdout.write(output)
  }
}

function runCreate (input) {
  if (!argv.createdBy) {
    argv.createdBy = 'WebTorrent <https://webtorrent.io>'
  }

  createTorrent(input, argv, (err, torrent) => {
    if (err) {
      return errorAndExit(err)
    }

    if (argv.out) {
      fs.writeFileSync(argv.out, torrent)
    } else {
      process.stdout.write(torrent)
    }
  })
}

function runPieceDownload(torrentId) {
  let pieceDownload = (argv.btpartCount || argv.pieceSelect) ? true : false
  let pieceRange = []
  if (argv.pieceSelect) {
    const selections = [].concat(argv.pieceSelect)
    for (const s of selections) {
      const range = s.split(' ')
      pieceRange.push({
        pieceStart: parseInt(range[0]),
        pieceEnd: parseInt(range[1])
      })
    }
  } else {
    pieceRange = null
  }
  console.log('runPieceDownload:', Date())
  const startTime = Date.now()
  let wcl = new WebTorrentCli(argv)
  wcl.add(torrentId, {
    pieceDownload: pieceDownload,
    out: argv.out,
    announce: argv.announce,
    btpartCount: argv.btpartCount,
    btpartIndex: argv.btpartIndex,
    pieceStart: argv.pieceStart,
    pieceEnd: argv.pieceEnd,
    pieceRange:  pieceRange,
    keepSeeding: argv['keep-seeding'] || false,
    saveTorrent: argv.saveTorrent || false
  }, torrent => {
    console.log('on torrent.', Date())
    const torrentTime = Date.now()
    const torrentLength = torrent.length
    console.log('start download torrent spend millis:', torrentTime - startTime)
    torrent.on('done', () => {
      console.log('Download done.', Date())
      const doneTime = Date.now()
      const spend = doneTime - torrentTime
      console.log('download torrent spend millis:', spend, 'torrent length:', torrentLength, 'download speed:', torrentLength/(spend/1000))
      if (argv.out && !argv['keep-seeding']) {
        gracefulExit()
        wcl.destroy(() => {
          setTimeout(() => process.exit(0), 1000).unref()
        })
      }
    })
  })
}

async function runDownload (torrentId) {
  if (!argv.out && !argv.stdout && !playerName) {
    argv.out = process.cwd()
  }
  let tracker
  if (argv.rtcConfig) {
    let a = JSON.parse(argv.rtcConfig)
    if (a) tracker = { rtcConfig: a }
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port'],
    downloadLimit: argv.downloadLimit,
    uploadLimit: argv.uploadLimit,
    tracker: tracker,
    dht: argv.disableDht === true ? false : true,
    lsd: argv.disableLsd === true ? false : true
  })
  client.on('error', fatalError)

  const torrent = client.add(torrentId, {
    path: argv.out,
    announce: argv.announce,
    announceAuth: argv.announceAuth
  })

  if (argv.verbose) {
    torrent.on('warning', handleWarning)
  }

  torrent.on('infoHash', () => {
    if ('select' in argv) {
      torrent.so = argv.select.toString()
    }

    if (argv.quiet) return

    updateMetadata()
    torrent.on('wire', updateMetadata)

    function updateMetadata () {
      console.clear()
      console.log(chalk`{green fetching torrent metadata from} {bold ${torrent.numPeers}} {green peers}`)
    }

    torrent.on('metadata', () => {
      console.clear()
      torrent.removeListener('wire', updateMetadata)

      console.clear()
      console.log(chalk`{green verifying existing torrent data...}`)
    })
  })

  torrent.on('done', () => {
    torrentCount -= 1
    if (!argv.quiet) {
      const numActiveWires = torrent.wires.reduce((num, wire) => num + (wire.downloaded > 0), 0)

      console.log(chalk`\ntorrent downloaded {green successfully} from {bold ${numActiveWires}/${torrent.numPeers}} {green peers} in {bold ${getRuntime()}s}!`)
    }
    if (argv.onDone) {
      cp.spawn(argv.onDone[0], argv.onDone.slice(1), { shell: true })
        .on('error', (err) => fatalError(err))
        .stderr.on('data', (err) => fatalError(err))
        .unref()
    }
    if (!playerName && !serving && argv.out && !argv['keep-seeding']) {
      torrent.destroy()

      if (torrentCount === 0) {
        gracefulExit()
      }
    }
  })

  // Start http server
  server = torrent.createServer()

  server.listen(argv.port)
    .on('error', err => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        // If port is taken, pick one a free one automatically
        server.close()
        const serv = server.listen(0)
        argv.port = server.address().port
        return serv
      } else return fatalError(err)
    })

  server.once('listening', initServer)
  server.once('connection', () => (serving = true))

  function initServer () {
    if (torrent.ready) {
      onReady()
    } else {
      torrent.once('ready', onReady)
    }
  }

  async function onReady () {
    if (argv.select && typeof argv.select !== 'number') {
      console.log('Select a file to download:')

      torrent.files.forEach((file, i) => console.log(
        chalk`{bold.magenta %s} %s {blue (%s)}`,
        i.toString().padEnd(2), file.name, prettierBytes(file.length)
      ))

      console.log('\nTo select a specific file, re-run `webtorrent` with "--select [index]"')
      console.log('Example: webtorrent download "magnet:..." --select 0')

      return gracefulExit()
    }

    if (argv['interactive-select'] && torrent.files.length > 1) {
      const paths = torrent.files.map(d => d.path)
      const answers = await inquirer.prompt([{
        type: 'list',
        name: 'file',
        message: 'Choose one file',
        choices: Array.from(torrent.files)
          .sort((file1, file2) => file1.path.localeCompare(file2.path))
          .map(function (file, i) {
            return {
              name: file.name + ' : ' + prettierBytes(file.length),
              value: paths.indexOf(file.path)
            }
          })
      }])
        .catch(err => {
          if (err.isTtyError) {
            return errorAndExit('Could not render interactive selection mode in this terminal.')
          } else {
            return errorAndExit('Could not start interactive selection mode: ' + err)
          }
        })
      argv.select = answers.file
    }

    // if no index specified, use largest file
    const index = (typeof argv.select === 'number')
      ? argv.select
      : torrent.files.indexOf(torrent.files.reduce((a, b) => a.length > b.length ? a : b))

    if (!torrent.files[index]) {
      return errorAndExit(`There's no file that maps to index ${index}`)
    }

    onSelection(index)
  }

  async function onSelection (index) {
    href = (argv.airplay || argv.chromecast || argv.xbmc || argv.dlna)
      ? `http://${networkAddress()}:${server.address().port}`
      : `http://localhost:${server.address().port}`
    let allHrefs = []
    if (argv.playlist && (argv.mpv || argv.mplayer || argv.vlc || argv.smplayer)) {
      // set the selected to the first file if not specified
      if (typeof argv.select !== 'number') {
        index = 0
      }
      torrent.files.forEach((file, i) => allHrefs.push(JSON.stringify(`${href}/${i}/${encodeURIComponent(file.name)}`)))
      // set the first file to the selected index
      allHrefs = allHrefs.slice(index, allHrefs.length).concat(allHrefs.slice(0, index))
    } else {
      href += `/${index}/${encodeURIComponent(torrent.files[index].name)}`
    }

    if (playerName) {
      torrent.files[index].select()
    }

    if (argv.stdout) {
      torrent.files[index].createReadStream().pipe(process.stdout)
    }

    if (argv.vlc) {
      vlcCommand((err, vlcCmd) => {
        if (err) {
          return fatalError(err)
        }
        playerArgs.vlc[0] = vlcCmd
        argv.playlist ? openPlayer(playerArgs.vlc.concat(allHrefs)) : openPlayer(playerArgs.vlc.concat(JSON.stringify(href)))
      })
    } else if (argv.iina) {
      open(`iina://weblink?url=${href}`, { wait: true }).then(playerExit)
    } else if (argv.mplayer) {
      argv.playlist ? openPlayer(playerArgs.mplayer.concat(allHrefs)) : openPlayer(playerArgs.mplayer.concat(JSON.stringify(href)))
    } else if (argv.mpv) {
      argv.playlist ? openPlayer(playerArgs.mpv.concat(allHrefs)) : openPlayer(playerArgs.mpv.concat(JSON.stringify(href)))
    } else if (argv.omx) {
      openPlayer(playerArgs.omx.concat(JSON.stringify(href)))
    } else if (argv.smplayer) {
      argv.playlist ? openPlayer(playerArgs.smplayer.concat(allHrefs)) : openPlayer(playerArgs.smplayer.concat(JSON.stringify(href)))
    }

    function openPlayer (args) {
      cp.spawn(JSON.stringify(args[0]), args.slice(1), { stdio: 'ignore', shell: true })
        .on('error', (err) => {
          if (err) {
            const isMpvFalseError = playerName === 'mpv' && err.code === 4

            if (!isMpvFalseError) {
              return fatalError(err)
            }
          }
        })
        .on('exit', playerExit)
        .unref()
    }

    function playerExit () {
      if (argv.quit) {
        gracefulExit()
      }
    }

    if (argv.airplay) {
      const airplay = (await import('airplay-js')).default

      airplay.createBrowser()
        .on('deviceOn', device => device.play(href, 0, () => { }))
        .start()
    }

    if (argv.chromecast) {
      const chromecasts = (await import('chromecasts')).default()

      const opts = {
        title: `WebTorrent - ${torrent.files[index].name}`
      }

      if (argv.subtitles) {
        subtitlesServer.listen(0)
        opts.subtitles = [`http://${networkAddress()}:${subtitlesServer.address().port}/${encodeURIComponent(path.basename(argv.subtitles))}`]
        opts.autoSubtitles = true
      }

      chromecasts.on('update', player => {
        if (
          // If there are no named chromecasts supplied, play on all devices
          argv.chromecast === true ||
          // If there are named chromecasts, check if this is one of them
          [].concat(argv.chromecast).find(name => player.name.toLowerCase().includes(name.toLowerCase()))
        ) {
          player.play(href, opts)

          player.on('error', err => {
            err.message = `Chromecast: ${err.message}`
            return errorAndExit(err)
          })
        }
      })
    }

    if (argv.xbmc) {
      const xbmc = (await import('nodebmc')).default

      new xbmc.Browser()
        .on('deviceOn', device => device.play(href, () => { }))
    }

    if (argv.dlna) {
      const dlnacasts = (await import('dlnacasts')).default()

      dlnacasts.on('update', player => {
        const opts = {
          title: `WebTorrent - ${torrent.files[index].name}`,
          type: mime.getType(torrent.files[index].name)
        }

        if (argv.subtitles) {
          subtitlesServer.listen(0, () => {
            opts.subtitles = [
              `http://${networkAddress()}:${subtitlesServer.address().port}/${encodeURIComponent(path.basename(argv.subtitles))}`
            ]
            play()
          })
        } else {
          play()
        }

        function play () {
          player.play(href, opts)
        }
      })
    }
    drawTorrent(torrent)
  }
}

function runDownloadMeta (torrentId) {
  if (!argv.out && !argv.stdout) {
    argv.out = process.cwd()
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port'],
    downloadLimit: argv.downloadLimit,
    uploadLimit: argv.uploadLimit
  })
  client.on('error', fatalError)

  const torrent = client.add(torrentId, {
    store: MemoryChunkStore,
    announce: argv.announce,
    mdonly: true
  })

  torrent.on('infoHash', function () {
    const torrentFilePath = `${argv.out}/${this.infoHash}.torrent`

    if (argv.quiet) {
      return
    }

    updateMetadata()
    torrent.on('wire', updateMetadata)

    function updateMetadata () {
      console.clear()
      console.log(chalk`{green fetching torrent metadata from} {bold ${torrent.numPeers}} {green peers}`)
    }

    torrent.on('metadata', function () {
      console.clear()
      torrent.removeListener('wire', updateMetadata)

      console.clear()
      console.log(chalk`{green saving the .torrent file data to ${torrentFilePath} ...}`)
      fs.writeFileSync(torrentFilePath, this.torrentFile)
      gracefulExit()
    })
  })
}

function runSeed (input) {
  if (path.extname(input).toLowerCase() === '.torrent' || /^magnet:/.test(input)) {
    // `webtorrent seed` is meant for creating a new torrent based on a file or folder
    // of content, not a torrent id (.torrent or a magnet uri). If this command is used
    // incorrectly, let's just do the right thing.
    runDownload(input)
    return
  }

  let tracker
  if (argv.rtcConfig) {
    let a = JSON.parse(argv.rtcConfig)
    if (a) tracker = { rtcConfig: a }
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port'],
    downloadLimit: argv.downloadLimit,
    uploadLimit: argv.uploadLimit,
    tracker: tracker,
    dht: argv.disableDht === true ? false : true,
    lsd: argv.disableLsd === true ? false : true
  })

  client.on('error', fatalError)

  client.seed(input, {
    announce: argv.announce,
    announceAuth: argv.announceAuth
  }, torrent => {
    if (argv.quiet) {
      console.log(torrent.magnetURI)
    }

    drawTorrent(torrent)
  })
}

function runPieceSeed (input) {
  let pieceSeed = (argv.btpartCount || argv.pieceSelect) ? true : false
  let pieceRange = []
  if (argv.pieceSelect) {
    const selections = [].concat(argv.pieceSelect)
    for (const s of selections) {
      const range = s.split(' ')
      pieceRange.push({
        pieceStart: parseInt(range[0]),
        pieceEnd: parseInt(range[1])
      })
    }
  } else {
    pieceRange = null
  }
  console.log('runPieceSeed:', input, pieceRange)
  //let wcl = new WebTorrentCli(argv)
  let wcl = new MultiWebTorrentCli(argv)
  /*
  wcl.seed(input, {
    announce: argv.announce,
    pieceSeed: pieceSeed,
    btpartCount: argv.btpartCount,
    btpartIndex: argv.btpartIndex,
    pieceStart: argv.pieceStart,
    pieceEnd: argv.pieceEnd,
    pieceRange: pieceRange,
    torrentId: argv.torrentId
  }, torrent => {
    console.log(torrent.magnetURI)
  })
  */

  const opts = {
    announce: argv.announce,
    pieceSeed: pieceSeed,
    btpartCount: argv.btpartCount,
    btpartIndex: argv.btpartIndex,
    pieceStart: argv.pieceStart,
    pieceEnd: argv.pieceEnd,
    pieceRange: pieceRange,
    torrentId: argv.torrentId
  }

  let fQueue = []

  input.forEach(path => {
    iterFolder(path, f => {
      fQueue.push(f)
    })
  })

  let index = 0
  runSeedWork()

  function runSeedWork () {
    if (index < fQueue.length) {
      console.log('runSeedWork:', index, fQueue[index])
      wcl.seed(fQueue[index], opts, torrent => {
        console.log(torrent.magnetURI)
        index += 1
        runSeedWork()
      })
    }
  }

  function iterFolder (path, cb) {
    let st = fs.statSync(path, {throwIfNoEntry: false})
    if (!st) return
    if (st.isDirectory()) {
      const names = fs.readdirSync(path)
      if (names.length == 0) return
      names.forEach(name => {
        if (name.length > 2) {
          iterFolder(path + '/' + name, cb)
        }
      })
    } else if (st.isFile()) {
      if (typeof cb === 'function') cb(path)
    }
  }
}

let counter = 0
let prev = Date.now()
let markt = prev

function eventLoopLatency () {
  setInterval(() => {
    const ts = Date.now()
    const latency = ts - prev
    const lat2 = ts - markt
    if (latency > 2000) {
      console.log('Event loop latency:', latency)
      counter = 0
      markt = ts
    } else {
      counter += 1
      if (lat2 > 10000) {
        console.log('Avenge event loop latency:', lat2 / counter)
        counter = 0
        markt = ts
      }
    }
    prev = ts
  }, 0)
}

function runDaemon () {
  if (argv.profiler) eventLoopLatency()
  const format = function (bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB'
  }

  const memUsage = function () {
    const memoryUsage = process.memoryUsage()
    console.log(`heapTotal: ${format(memoryUsage.heapTotal)}, heapUsed: ${format(memoryUsage.heapUsed)}`)
    console.log(memoryUsage)
  }

  let client = new MultiWebTorrentCli({
    resumePath: argv.resumePath,
    rtcConfig: argv.rtcConfig,
    announce: argv.announce,
    savePath: argv.savePath,
    disableDht: argv.disableDht,
    disableLsd: argv.disableLsd
  })
  const resultOk = '{"status": "ok"}'
  const onCommand = (command, input, opts) => {
    let pieceRange
    if (opts.pieceSelect) {
      const selections = [].concat(opts.pieceSelect)
      pieceRange = []
      for (const s of selections) {
        const range = s.split(' ')
        pieceRange.push({
          pieceStart: parseInt(range[0]),
          pieceEnd: parseInt(range[1])
        })
      }
    }
    if (command === 'add') {
      client.add(input, {
        pieceDownload: opts.pieceDownload || false,
        out: opts.out,
        announce: opts.announce,
        btpartCount: opts.btpartCount,
        btpartIndex: opts.btpartIndex,
        pieceStart: opts.pieceStart,
        pieceEnd: opts.pieceEnd,
        pieceRange: pieceRange,
        keepSeeding: opts.keepSeeding || false,
        saveTorrent: opts.saveTorrent || false,
        timeout: opts.setTimeout
      }, _torrent => {
        console.log('on torrent:', input)
        memUsage()
      })
      console.log('add:', input)
      return resultOk
    } else if (command === 'seed') {
      client.seed(input, {
        announce: opts.announce,
        pieceSeed: opts.pieceSeed || false,
        btpartCount: opts.btpartCount,
        btpartIndex: opts.btpartIndex,
        pieceStart: opts.pieceStart,
        pieceEnd: opts.pieceEnd,
        pieceRange: pieceRange,
        torrentId: opts.torrentId,
        timeout: opts.setTimeout
      }, torrent => {
        console.log(torrent.magnetURI)
        memUsage()
      })
      console.log('seed:', input)
      return resultOk
    } else if (command === 'append') {
      let t = getTorrent(input)
      if (t) {
        let wtc = client.getClient(t.client)
        if (wtc) {
          wtc.append(t.index, opts.pieceStart, opts.pieceEnd, opts.seedPath)
        }
        return resultOk
      } else {
        return '{"status": "fail", "error": "Not found"}'
      }
    } else if (command === 'list') {
      let list = client.torrents
      if (!input) console.log('list:', list)

      const torrentStatus = (t) => {
        let s = 'wait'
        if (t.status && (t.status !== 'running')) {
          s = t.status
        } else if (t.seeding) {
          s = 'seeding'
        } else if (t.done || t.progress > 0.001) {
          s = 'ready'
        }
        return s
      }

      let rs = []
      if (input) {
        let t = list.find(item => item.infohash === input)
        if (t) {
          rs.push({
            status: torrentStatus(t),
            infohash: t.infohash,
            progress: t.progress,
            seedfiles: t.seedfiles
          })
        } else {
          return '{"error": "Not found"}'
        }
      } else {
        list.forEach(t => {
          rs.push({
            status: torrentStatus(t),
            infohash: t.infohash,
            progress: t.progress,
            seedfiles: t.seedfiles
          })
        })
      }
      return JSON.stringify({"data": rs})
    } else if (command === 'progress') {
      let t = getTorrent(input)
      if (t) {
        let p = t.progress
        console.log('progress:', p)
        return JSON.stringify({progress: p})
      } else {
        return '{"error": "Not found"}'
      }
    } else if (command === 'remove') {
      let t = getTorrent(input)
      if (t) {
        let wtc = client.getClient(t.client)
        if (wtc) {
          wtc.remove(t.index, err => {
            if (err) {
              console.log('remove error', input, err)
            }
          }, { removeTorrent: opts.removeTorrent || false })
        }
        return resultOk
      } else {
        return '{"status": "fail", "error": "Not found"}'
      }
    } else if (command === 'destroy') {
      let wtc = client.getClient(input)
      if (wtc) {
        wtc.destroy(err => {
          if (err) console.log('destroy error', err)
        }, { removeTorrent: opts.removeTorrent || false })
        return resultOk
      }
    } else if (command === 'quit') {
      console.log('quit..')
      setTimeout(() => process.exit(0), 1000).unref()
      return resultOk
    } else if (command === 'config') {
      return JSON.stringify({
        resumePath: argv.resumePath,
        rtcConfig: argv['rtc-config'],
        announce: argv.announce ? [].concat(argv.announce) : undefined,
        savePath: argv.savePath
      })
    } else if (command === 'memstat') {
      memUsage()
      return resultOk
    } else if (command === 'pause') {
      let t = getTorrent(input)
      if (t) {
        let wtc = client.getClient(t.client)
        if (wtc) {
          const r = wtc.pause(t.index, err => {
            if (err) {
              console.log('pause error', input, err)
            }
          })
          if (r === false) {
            return '{"status": "fail", "error": "Invalid params"}'
          } 
        }
        return resultOk
      } else {
        return '{"status": "fail", "error": "Not found"}'
      }
    } else if (command === 'resume') {
      let t = getTorrent(input)
      if (t) {
        let wtc = client.getClient(t.client)
        if (wtc) {
          const r = wtc.resume(t.index, err => {
            if (err) {
              console.log('resume error', input, err)
            }
          })
          if (r === false) {
            return '{"status": "fail", "error": "Invalid params"}'
          } 
        }
        return resultOk
      } else {
        return '{"status": "fail", "error": "Not found"}'
      }
    } else if (command === 'peerstat') {
      let t = getTorrent(input)
      if (t) {
        let wtc = client.getClient(t.client)
        if (wtc) {
          wtc.peerstat(t.index)
        }
        return resultOk
      } else {
        return '{"status": "fail", "error": "Not found"}'
      }
    }
    return '{"status": "fail", "error": "invalid command"}'
  }

  const getTorrent = (infohash) => {
    let list = client.torrents
    let t = list.find(item => item.infohash === infohash)
    return t
  };

  const server = net.createServer(c => {
    console.log('client connected:', c.address())
    c.on('end', () => {
      console.log('client disconnected');
    })
    c.on('data', data => {
      console.log('recved:', data.toString())
      const requstParser = Yargs()
      let opts = requstParser.parse(data.toString())
      console.log(opts)
      console.log('argv:', opts._, opts._.length, opts._[0])
      let result = '{"status": "fail", "error": "invalid command"}'
      if (opts._.length > 1) {
        result = onCommand(opts._[0], opts._[1], opts)
      } else if (opts._.length > 0) {
        result = onCommand(opts._[0], null, opts)
      }
      c.write(result)
    })
  })
  server.on('error', err => {
    fatalError(err)
  })
  const sock = '/var/run/webtorrent.sock'
  try {
    fs.unlinkSync(sock)
  } catch (error) {
    console.log('unlink error:', error.name, error.message)
  }

  const startServer = () => {
    server.listen(sock, () => {
      console.log('server bound.')
    })
  }

  const httpServer = http.createServer((req, res) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
    })
    req.on('end', () => {
      console.log('http recv:', data)
      const requstParser = Yargs()
      let opts = requstParser.parse(data.toString())
      console.log(opts)
      let result = '{"status": "fail", "error": "invalid command"}'
      if (opts._.length > 1) {
        result = onCommand(opts._[0], opts._[1], opts)
      } else if (opts._.length > 0) {
        result = onCommand(opts._[0], null, opts)
      }
      console.log('command done:', data)
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write(result)
      res.end()
      console.log('http end:', data)
    })
  })
  httpServer.on('error', err => {
    fatalError(err)
  })
  const httpSock = '/var/run/webtorrent_http.sock'
  try {
    fs.unlinkSync(httpSock)
  } catch (error) {
    console.log('unlink error:', error.name, error.message)
  }

  const startHttpServer = () => {
    httpServer.listen(httpSock, () => {
      console.log('http server started.')
    })
  }

  if (client._loadCount === 0) {
    startServer()
    startHttpServer()
  } else {
    client.once('loaded', () => {
      console.log('client complete load.')
      startServer()
      startHttpServer()
    })
  }
}

function drawTorrent (torrent) {
  if (!argv.quiet) {
    console.clear()
    drawInterval = setInterval(draw, 1000)
    drawInterval.unref()
  }

  let hotswaps = 0
  torrent.on('hotswap', () => (hotswaps += 1))

  let blockedPeers = 0
  torrent.on('blockedPeer', () => (blockedPeers += 1))

  function draw () {
    const unchoked = torrent.wires
      .filter(wire => !wire.peerChoking)

    let linesRemaining = process.stdout.rows
    let peerslisted = 0

    const speed = torrent.downloadSpeed
    const estimate = torrent.timeRemaining
      ? moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize()
      : 'N/A'

    const runtimeSeconds = getRuntime()
    const runtime = runtimeSeconds > 300
      ? moment.duration(getRuntime(), 'seconds').humanize()
      : `${runtimeSeconds} seconds`
    const seeding = torrent.done

    console.clear()

    line(chalk`{green ${seeding ? 'Seeding' : 'Downloading'}:} {bold ${torrent.name}}`)

    if (seeding) line(chalk`{green Info hash:} ${torrent.infoHash}`)

    const portInfo = []
    if (argv['torrent-port']) portInfo.push(chalk`{green Torrent port:} ${argv['torrent-port']}`)
    if (argv['dht-port']) portInfo.push(chalk`{green DHT port:} ${argv['dht-port']}`)
    if (portInfo.length) line(portInfo.join(' '))

    if (playerName) {
      line(chalk`{green Streaming to:} {bold ${playerName}}  {green Server running at:} {bold ${href}}`)
    } else if (server) {
      line(chalk`{green Server running at:}{bold ${href}}`)
    }

    if (argv.out) {
      line(chalk`{green Downloading to:} {bold ${argv.out}}`)
    }

    line(chalk`{green Speed:} {bold ${prettierBytes(speed)
      }/s} {green Downloaded:} {bold ${prettierBytes(torrent.downloaded)
      }}/{bold ${prettierBytes(torrent.length)}} {green Uploaded:} {bold ${prettierBytes(torrent.uploaded)
      }}`)

    line(chalk`{green Running time:} {bold ${runtime
      }}  {green Time remaining:} {bold ${estimate
      }}  {green Peers:} {bold ${unchoked.length
      }/${torrent.numPeers
      }}`)

    if (argv.verbose) {
      line(chalk`{green Queued peers:} {bold ${torrent._numQueued
        }}  {green Blocked peers:} {bold ${blockedPeers
        }}  {green Hotswaps:} {bold ${hotswaps
        }}`)

      if (torrent.bitfield) {
        line(chalk`{green Bitfield:} ${torrent.bitfield.buffer}`)
      }
    }

    line('')

    torrent.wires.every(wire => {
      let progress = '?'

      if (torrent.length) {
        let bits = 0

        const piececount = Math.ceil(torrent.length / torrent.pieceLength)

        for (let i = 0; i < piececount; i++) {
          if (wire.peerPieces.get(i)) {
            bits++
          }
        }

        progress = bits === piececount
          ? 'S'
          : `${Math.floor(100 * bits / piececount)}%`
      }

      let str = chalk`%s {magenta %s} %s {cyan %s} {red %s}`

      const args = [
        progress.padEnd(3),
        (wire.remoteAddress
          ? `${wire.remoteAddress}:${wire.remotePort}`
          : 'Unknown').padEnd(25),
        prettierBytes(wire.downloaded).padEnd(10),
        (prettierBytes(wire.downloadSpeed()) + '/s').padEnd(12),
        (prettierBytes(wire.uploadSpeed()) + '/s').padEnd(12)
      ]

      if (argv.verbose) {
        str += chalk` {grey %s} {grey %s}`

        const tags = []

        if (wire.requests.length > 0) {
          tags.push(`${wire.requests.length} reqs`)
        }

        if (wire.peerChoking) {
          tags.push('choked')
        }

        const reqStats = wire.requests
          .map(req => req.piece)

        args.push(tags.join(', ').padEnd(15), reqStats.join(' ').padEnd(10))
      }

      line(...[].concat(str, args))

      peerslisted += 1
      return linesRemaining > 4
    })

    line(''.padEnd(60))

    if (torrent.numPeers > peerslisted) {
      line('... and %s more', torrent.numPeers - peerslisted)
    }

    function line (...args) {
      console.log(...args)
      linesRemaining -= 1
    }
  }
}

function handleWarning (err) {
  console.warn(`Warning: ${err.message || err}`)
}

function fatalError (err) {
  console.log(chalk`{red Error:} ${err.message || err}`)
  process.exit(1)
}

function errorAndExit (err) {
  console.log(chalk`{red Error:} ${err.message || err}`)
  expectedError = true
  process.exit(1)
}

function gracefulExit () {
  if (gracefullyExiting) {
    return
  }

  gracefullyExiting = true

  console.log(chalk`\n{green webtorrent is exiting...}`)

  process.removeListener('SIGINT', gracefulExit)
  process.removeListener('SIGTERM', gracefulExit)

  if (!client) {
    return
  }

  if (subtitlesServer) {
    subtitlesServer.close()
  }

  clearInterval(drawInterval)

  if (argv.onExit) {
    cp.spawn(argv.onExit[0], argv.onExit.slice(1), { shell: true })
      .on('error', (err) => fatalError(err))
      .stderr.on('data', (err) => fatalError(err))
      .unref()
  }

  client.destroy(err => {
    if (err) {
      return fatalError(err)
    }

    // Quit after 1 second. This is only necessary for `webtorrent-hybrid` since
    // the `electron-webrtc` keeps the node process alive quit.
    setTimeout(() => process.exit(0), 1000)
      .unref()
  })
}

function enableQuiet () {
  argv.quiet = argv.q = true
}

function getRuntime () {
  return Math.floor((Date.now() - argv.startTime) / 1000)
}

function processInputs (inputs, fn) {
  // These arguments do not make sense when downloading multiple torrents, or
  // seeding multiple files/folders.
  if (Array.isArray(inputs) && inputs.length !== 0) {
    if (inputs.length > 1) {
      const invalidArguments = [
        'airplay', 'chromecast', 'dlna', 'mplayer', 'mpv', 'omx', 'vlc', 'iina', 'xbmc',
        'stdout', 'select', 'subtitles', 'smplayer'
      ]

      invalidArguments.forEach(arg => {
        if (argv[arg]) {
          return errorAndExit(new Error(
            `The --${arg} argument cannot be used with multiple files/folders.`
          ))
        }
      })
      torrentCount = inputs.length
      enableQuiet()
    }
    inputs.forEach(input => fn(input))
  } else {
    yargs.showHelp('log')
  }
}
