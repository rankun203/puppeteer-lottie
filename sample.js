'use strict'
// test script to use this library
//
// $ node test.js

const tempy = require('tempy')

const renderLottie = require('.')

const output = tempy.file({ extension: 'png' })

;(async () => {
  await renderLottie({
    path: 'fixtures/tgs_file_267630.json',
    quiet: true,
    output,
    puppeteerOptions: {
      headless: false
    }
  })
})()
