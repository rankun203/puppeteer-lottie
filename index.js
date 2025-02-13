'use strict'

const fs = require('fs-extra')
const execa = require('execa')
const ora = require('ora')
const ow = require('ow')
const path = require('path')
const pluralize = require('pluralize')
const puppeteer = require('puppeteer')
const tempy = require('tempy')
const { spawn } = require('child_process')
const { sprintf } = require('sprintf-js')

const { cssifyObject } = require('css-in-js-utils')

const lottieScript = fs.readFileSync(
  path.join(__dirname, 'lib', 'lottie.min.js'),
  'utf8'
)

const injectLottie = `
<script>
  ${lottieScript}
</script>
`

/**
 * Renders the given Lottie animation via Puppeteer.
 *
 * You must pass either `path` or `animationData` to specify the Lottie animation.
 *
 * `output` must be one of the following:
 *   - An image to capture the first frame only (png or jpg)
 *   - An image pattern (eg. sprintf format 'frame-%d.png' or 'frame-%012d.jpg')
 *   - An mp4 video file (requires FFmpeg to be installed)
 *   - A GIF file (requires Gifski to be installed)
 *
 * @name renderLottie
 * @function
 *
 * @param {object} opts - Configuration options
 * @param {string} opts.output - Path or pattern to store result
 * @param {object} [opts.animationData] - JSON exported animation data
 * @param {string} [opts.path] - Relative path to the JSON file containing animation data
 * @param {number} [opts.width] - Optional output width
 * @param {number} [opts.height] - Optional output height
 * @param {object} [opts.jpegQuality=90] - JPEG quality for frames (does nothing if using png)
 * @param {object} [opts.quiet=false] - Set to true to disable console output
 * @param {number} [opts.deviceScaleFactor=1] - Window device scale factor
 * @param {string} [opts.renderer='svg'] - Which lottie-web renderer to use
 * @param {object} [opts.rendererSettings] - Optional lottie renderer settings
 * @param {object} [opts.puppeteerOptions] - Optional puppeteer launch settings
 * @param {object} [opts.gifskiOptions] - Optional gifski settings (only for GIF outputs)
 * @param {object} [opts.style={}] - Optional JS [CSS styles](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Properties_Reference) to apply to the animation container
 * @param {object} [opts.inject={}] - Optionally injects arbitrary string content into the head, style, or body elements.
 * @param {string} [opts.inject.head] - Optionally injected into the document <head>
 * @param {string} [opts.inject.style] - Optionally injected into a <style> tag within the document <head>
 * @param {string} [opts.inject.body] - Optionally injected into the document <body>
 * @param {object} [opts.browser] - Optional puppeteer instance to reuse
 *
 * @return {Promise}
 */
module.exports = async (opts) => {
  const {
    output,
    animationData = undefined,
    path: animationPath = undefined,
    jpegQuality = 90,
    quiet = false,
    deviceScaleFactor = 1,
    renderer = 'svg',
    rendererSettings = {},
    style = {},
    inject = {},
    puppeteerOptions = {},
    ffmpegOptions = {
      crf: 20,
      profileVideo: 'main',
      preset: 'medium'
    },
    gifskiOptions = {
      quality: 80,
      fast: false
    }
  } = opts

  let { width = undefined, height = undefined, widthStatic = undefined } = opts

  ow(output, ow.string.nonEmpty, 'output')
  ow(deviceScaleFactor, ow.number.integer.positive, 'deviceScaleFactor')
  ow(renderer, ow.string.oneOf(['svg', 'canvas', 'html'], 'renderer'))
  ow(rendererSettings, ow.object.plain, 'rendererSettings')
  ow(puppeteerOptions, ow.object.plain, 'puppeteerOptions')
  ow(
    ffmpegOptions,
    ow.object.exactShape({
      crf: ow.number.is((val) => {
        return val >= 0 && val <= 51
      }),
      profileVideo: ow.string.oneOf([
        'baseline',
        'main',
        'high',
        'high10',
        'high422',
        'high444'
      ]),
      preset: ow.string.oneOf([
        'ultrafast',
        'superfast',
        'veryfast',
        'faster',
        'fast',
        'medium',
        'slow',
        'slower',
        'veryslow',
        'placebo'
      ])
    })
  )
  ow(style, ow.object.plain, 'style')
  ow(inject, ow.object.plain, 'inject')

  const ext = path.extname(output).slice(1).toLowerCase()
  const isGif = ext === 'gif'
  const isMp4 = ext === 'mp4'
  const isPng = ext === 'png'
  const isJpg = ext === 'jpg' || ext === 'jpeg'

  if (!(isGif || isMp4 || isPng || isJpg)) {
    throw new Error(`Unsupported output format "${output}"`)
  }

  const tempDir = isGif ? tempy.directory() : undefined
  const tempOutput = isGif ? path.join(tempDir, 'frame-%012d.png') : output
  const frameType = isJpg ? 'jpeg' : 'png'
  const isMultiFrame = isMp4 || /%d|%\d{2,3}d/.test(tempOutput)

  let lottieData = animationData

  if (animationPath) {
    if (animationData) {
      throw new Error('"animationData" and "path" are mutually exclusive')
    }

    ow(animationPath, ow.string.nonEmpty, 'path')

    lottieData = fs.readJsonSync(animationPath)
  } else if (animationData) {
    ow(animationData, ow.object.plain.nonEmpty, 'animationData')
  } else {
    throw new Error('Must pass either "animationData" or "path"')
  }

  const fps = ~~lottieData.fr
  const nm = ~~lottieData.nm
  const { w = 640, h = 480 } = lottieData
  const aR = w / h

  ow(fps, ow.number.integer.positive, 'animationData.fr')
  ow(w, ow.number.integer.positive, 'animationData.w')
  ow(h, ow.number.integer.positive, 'animationData.h')

  if (!(width && height)) {
    if (width) {
      height = Math.round(width / aR)
    } else if (height) {
      width = Math.round(height * aR)
    } else {
      width = w
      height = h
    }
  }

  width = width | 0
  height = height | 0

  !quiet && console.log('width, height, w, h', width, height, w, h)

  // rendererSettings processing
  const fpsScale = rendererSettings.fpsScale || 1
  rendererSettings.fpsScale = undefined

  const html = `
<html>
<head>
  <meta charset="UTF-8">

  ${inject.head || ''}
  ${injectLottie}

  <style>
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background: transparent;
  width: ${w}px;
  height: ${h}px;
  overflow: hidden;
}

#root {
  ${cssifyObject(style)}
}

  ${inject.style || ''}
  </style>
</head>

<body>
${inject.body || ''}

<div id="root"></div>

<script>
  const animationData = ${JSON.stringify(lottieData)}
  let animation = null
  let duration
  let numFrames

  function onReady () {
    animation = lottie.loadAnimation({
      container: document.getElementById('root'),
      renderer: '${renderer}',
      loop: false,
      autoplay: false,
      rendererSettings: ${JSON.stringify(rendererSettings)},
      animationData
    })

    duration = animation.getDuration()
    firstFrame = animation.firstFrame
    numFrames = animation.totalFrames
    window.lottie_animation = animation

    var div = document.createElement('div')
    div.className = 'ready'
    document.body.appendChild(div)
  }

  document.addEventListener('DOMContentLoaded', onReady)
</script>

</body>
</html>
`

  // useful for testing purposes
  // fs.writeFileSync('test.html', html)

  const spinnerB = !quiet && ora('Loading browser').start()

  const browser =
    opts.browser ||
    (await puppeteer.launch({ headless: 'new', ...puppeteerOptions }))
  const page = await browser.newPage()
  let duration
  let firstFrame
  let numFrames
  try {
    // Inside page, try start
    if (!quiet) {
      !quiet && page.on('console', console.log.bind(console))
      page.on('error', console.error.bind(console))
    }

    await page.setViewport({ deviceScaleFactor, width: w, height: h })
    await page.setContent(html)
    await page.waitForSelector('.ready')
    duration = await page.evaluate(() => duration)
    firstFrame = await page.evaluate(() => firstFrame)
    numFrames = await page.evaluate(() => numFrames)
    // numFrames might have some flashing bug when is 91 frames
    if (numFrames % 2 === 1 && numFrames > 1) --numFrames

    const pageFrame = page.mainFrame()
    const rootHandle = await pageFrame.$('#root')

    let targetFps = Math.floor(fps * fpsScale)
    // Don't make it too small
    if (targetFps < 20) {
      targetFps = fps
    }

    const screenshotOpts = {
      omitBackground: true,
      type: frameType,
      quality: frameType === 'jpeg' ? jpegQuality : undefined
    }

    if (spinnerB) {
      spinnerB.succeed()
    }

    const numOutputFrames = isMultiFrame ? numFrames : 1
    const framesLabel = pluralize('frame', numOutputFrames)
    const spinnerR =
      !quiet && ora(`Rendering ${numOutputFrames} ${framesLabel}`).start()

    let ffmpegP
    let ffmpeg
    let ffmpegStdin

    if (isMp4) {
      ffmpegP = new Promise((resolve, reject) => {
        let scale = `scale=${width}:-2`

        if (width % 2 !== 0) {
          if (height % 2 === 0) {
            scale = `scale=-2:${height}`
          } else {
            scale = `scale=${width + 1}:-2`
          }
        }

        const ffmpegArgs = [
          '-v',
          'error',
          '-stats',
          '-hide_banner',
          '-y',
          '-f',
          'image2pipe',
          '-c:v',
          'png',
          '-r',
          targetFps,
          '-i',
          '-',
          '-vf',
          scale,
          '-c:v',
          'libx264',
          '-profile:v',
          ffmpegOptions.profileVideo,
          '-preset',
          ffmpegOptions.preset,
          '-crf',
          ffmpegOptions.crf,
          '-movflags',
          'faststart',
          '-pix_fmt',
          'yuv420p',
          '-an',
          output
        ]

        !quiet && console.log('ffmpeg', ffmpegArgs.join(' '))

        ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgs)
        const { stdin, stdout, stderr } = ffmpeg

        if (!quiet) {
          stdout.pipe(process.stdout)
        }
        stderr.pipe(process.stderr)

        stdin.on('error', (err) => {
          if (err.code !== 'EPIPE') {
            return reject(err)
          }
        })

        ffmpeg.on('exit', async (status) => {
          if (status) {
            return reject(new Error(`FFmpeg exited with status ${status}`))
          } else {
            return resolve()
          }
        })

        ffmpegStdin = stdin
      })
    }

    // for changing target fps
    const deleteStep = Math.round(
      numFrames / (numFrames - numFrames * (targetFps / fps))
    )
    for (let frame = firstFrame; frame < numFrames; ++frame) {
      if (frame > 0 && frame % deleteStep === 0) continue

      const frameOutputPath = isMultiFrame
        ? sprintf(tempOutput, frame)
        : tempOutput

      // eslint-disable-next-line no-undef
      await page.evaluate((frame) => animation.goToAndStop(frame, true), frame)
      const screenshot = await rootHandle.screenshot({
        path: isMp4 ? undefined : frameOutputPath,
        ...screenshotOpts
      })

      // single screenshot
      if (!isMultiFrame) {
        break
      }

      if (isMp4) {
        if (ffmpegStdin.writable) {
          ffmpegStdin.write(screenshot)
        }
      }
    }

    await rootHandle.dispose()

    if (opts.browser) {
      await page.close()
    } else {
      await browser.close()
    }

    if (spinnerR) {
      spinnerR.succeed()
    }

    if (isMp4) {
      const spinnerF = !quiet && ora(`Generating mp4 with FFmpeg`).start()

      ffmpegStdin.end()
      await ffmpegP

      if (spinnerF) {
        spinnerF.succeed()
      }
    } else if (isGif) {
      const spinnerG =
        !quiet && ora(`Generating GIF with Gifski / ffmpeg`).start()

      const framePattern = tempOutput.replace('%012d', '*')
      const escapePath = (arg) => arg.replace(/(\s+)/g, '\\$1')

      const framesSoftOutput = tempOutput.replace('frame-', 'frame-soft-')
      const framesSoftOutputAsInput = framePattern.replace(
        'frame-',
        'frame-soft-'
      )
      const isSingle = numFrames === 1

      // convert: soften edges by removing semi-transparent pixels that's too transparent < 80% opaque
      await execa.shell(
        [
          process.env.CONVERT_PATH || 'convert',
          escapePath(framePattern),
          '-resize',
          `${isSingle ? widthStatic : width}x`,
          '-channel',
          'alpha',
          '-threshold',
          '80%',
          '+channel',
          framesSoftOutput
        ].join(' ')
      )

      const params = [
        '-o',
        output,
        '--fps',
        gifskiOptions.fps || targetFps,
        gifskiOptions.fast && '--fast',
        '--quality',
        gifskiOptions.quality,
        '--width ' + (isSingle ? widthStatic : width),
        '--quiet',
        escapePath(framesSoftOutputAsInput),
        isSingle && escapePath(framesSoftOutputAsInput)
      ].filter(Boolean)

      const executable = process.env.GIFSKI_PATH || 'gifski'
      const cmd = [executable].concat(params).join(' ')

      await execa.shell(cmd)

      if (spinnerG) {
        spinnerG.succeed()
      }
    } else {
      if (tempOutput !== output) {
        const cmd_conversion = [
          process.env.FFMPEG_PATH || 'ffmpeg',
          '-i',
          tempOutput,
          `-filter:v scale=${width}:${height}`,
          output
        ].join(' ')
        // just do a file conversion
        !quiet && console.log('cmd_conversion', cmd_conversion)
        await execa.shell(cmd_conversion)
      } else {
        !quiet &&
          console.log(
            'nothing to convert, tempOutput === output',
            tempOutput,
            output
          )
      }
    }
    // Inside page, try ended
  } catch (err) {
    console.error('processing failed', err)
    await page.close()
    throw err
  }

  if (tempDir) {
    !quiet && console.log('index.js tempDir removed', tempDir)
    // await fs.remove(tempDir)
  }

  return {
    numFrames,
    duration,
    name: nm
  }
}
