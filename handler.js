'use strict';

let AWS = require('aws-sdk');
const fs = require('fs');
const _ = require('underscore');
const _l = require('lodash');
const when = require('when');
const rest = require('restler');
const sm = require('sitemap');
const zlib = require('zlib');
const str = require('string-to-stream');
const builder = require('xmlbuilder');
const Knex = require('knex');
const isLocal = process.env.IS_LOCAL;
const s3Stream = require('s3-upload-stream')(new AWS.S3());

module.exports.sitemap = async (event = {}, context) => {
  if (isLocal) {
    event = require('./events/event.json');
  }
  const siteMapBucket = isLocal
    ? event.sitemap_bucket
    : process.env.SITEMAP_BUCKET;
  const basePath = isLocal ? event.base_path : process.env.BASE_PATH;
  const siteURL = isLocal ? event.site_url : process.env.SITE_URL;

  let connection;
  try {
    if ([siteMapBucket, basePath, siteURL].some(value => !value)) {
      console.log('ERROR: Missing variables', siteMapBucket, basePath, siteURL);
      return;
    }
    connection = Knex({
      client: !isLocal ? process.env.DB_CLIENT : 'mysql',
      connection: {
        host: !isLocal ? process.env.DB_HOST : '127.0.0.1',
        user: !isLocal ? process.env.DB_USER : 'root',
        password: !isLocal ? process.env.DB_PASS : '',
        database: !isLocal ? process.env.DB_NAME : 'test',
      },
    });
    if (!connection) {
      console.log('ERROR: no connection to db');
      throw 'no connection';
    }

    const date = new Date();
    const sitemapIndex = 'sitemap.xml.gz';
    const sitemapGeneratedPrefix = 'sitemap_';
    const items = getArrayOfItems();

    let chunks = _l.chunk(items, 10000);
    await when.iterate(
      function(index) {
        return index + 1;
      },
      function(index) {
        return index > chunks.length - 1;
      },
      async function(index) {
        const chunk = chunks[index];
        const urls = [];
        _.each(chunk, function(item) {
          const type = 'customType';
          const slug = '{YOUR_UNIQUE_SLUG_HERE}';
          urls.push({
            url: basePath + slug,
            changefreq: 'daily',
            priority: 0.5,
            lastmod: date,
          });
        });
        console.log('Creating Sitemap...');
        // Create the sitemap in memory
        // @ts-ignore
        let sitemap = sm.createSitemap({
          hostname: siteURL,
          cacheTime: 600000, //600 sec (10 min) cache purge period
          urls,
        });
        console.log('Sitemap created.');
        console.log(
          `Uploading indexed sitemaps to S3 bucket ${siteMapBucket}...`,
        );
        // Write the sitemap file
        await upload({
          content: sitemap.toString(),
          filename: sitemapGeneratedPrefix + (index + 1) + '.xml.gz',
          siteMapBucket,
        });
        return;
      },
      0,
    );

    // Now create the Master sitemap index
    let root = builder
      .create('sitemapindex', {encoding: 'UTF-8'})
      .att('xmlns', 'http://www.sitemaps.org/schemas/sitemap/0.9');

    // add in each sitemap
    _.each(chunks, function(chunk, index) {
      let sitemap = root.ele('sitemap');
      sitemap.ele(
        'loc',
        siteURL + '/' + sitemapGeneratedPrefix + (index + 1) + '.xml.gz',
      );
      sitemap.ele('lastmod', new Date().toISOString());
    });

    let xmlString = root.end({
      pretty: true,
      indent: '  ',
      newline: '\n',
      allowEmpty: false,
    });

    // Upload Master index sitemap
    console.log(`Uploading master sitemap to S3 bucket ${siteMapBucket}...`);
    await upload({content: xmlString, filename: sitemapIndex, siteMapBucket});
    console.log('Upload complete.');

    // now ping Google to tell them the sitemap is updated;
    if (!isLocal) {
      await pingGoogle({siteURL, sitemapIndex});
    }

    if (connection) {
      connection.destroy(function(err) {
        if (err) console.error('end connection: ', err);
      });
    }
    context.succeed('Successfully created sitemap');
    console.log('Done.');
  } catch (error) {
    console.log('ERROR: ', error);
  } finally {
    if (connection) {
      connection.destroy();
      console.log('Connection closed.');
    }
  }
};

async function pingGoogle({siteURL, sitemapIndex}) {
  console.log('Pinging Google sitemap has been updated...');
  await when.promise(function(resolve, reject, notify) {
    rest
      .get('http://google.com/ping?sitemap=' + siteURL + '/' + sitemapIndex)
      .on('success', function(data, response) {
        console.log('Google Ping: ' + data);
        resolve();
      })
      .on('fail', function(data, response) {
        console.log('Google Ping Error:', data);
        resolve();
      });
  });
  console.log('Google pinged.');
}

async function upload({content, filename, siteMapBucket}) {
  try {
    await new Promise((resolve, reject) => {
      if (isLocal) {
        writeFile({path: './test', content, filename});
        return resolve('Test File written and upload skipped');
      }
      // Create the streams
      const read = str(content);
      const compress = zlib.createGzip();
      const uploadToS3 = s3Stream.upload({
        Bucket: siteMapBucket,
        Key: filename,
      });

      // Optional configuration
      uploadToS3.maxPartSize(20971520); // 20 MB
      uploadToS3.concurrentParts(5);

      // Handle errors.
      uploadToS3.on('error', function(error) {
        console.error('error: ', error);
        reject(error);
      });

      uploadToS3.on('part', function(details) {
        // console.log('part', details);
      });
      uploadToS3.on('uploaded', function(details) {
        console.log('uploaded: ', details.Location);
        resolve(details);
      });
      // Pipe the incoming stream through compression, and up to S3.
      read.pipe(compress).pipe(uploadToS3);
    });
  } catch (error) {
    console.log('ERROR: ', error);
  }
}

function writeFile({path, content, filename}) {
  fs.writeFile(`${path}/${filename}`, content, function(err) {
    if (err) {
      return console.log(err);
    }

    console.log('The file was saved!');
  });
}

function getArrayOfItems(){
  return []
}
