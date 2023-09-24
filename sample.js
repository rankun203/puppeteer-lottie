'use strict'
// test script to use this library
//
// $ node test.js

const tempy = require('tempy')

const renderLottie = require('.')

const output = tempy.file({ extension: 'gif' })

;(async () => {
  await renderLottie({
    path: 'fixtures/tgs_file_267630.json',
    output,
    puppeteerOptions: {
      headless: false
    }
  })
  console.log('input', __dirname + '/fixtures/tgs_file_267630.json')
  console.log('output', output)
})()
