'use strict';

/**
 * CLI runner — use this to download photos directly from the terminal
 * without needing the web server.
 *
 * Usage:
 *   node src/cli.js                   # download everything
 *   node src/cli.js --mode albums     # only by albums
 *   node src/cli.js --mode date       # only by date
 *
 * You must first obtain an OAuth token by running the web server,
 * signing in, and then saving the session tokens to .tokens.json
 * (the server does this automatically when you visit /auth/save-token).
 */

require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');

// ora and chalk are CommonJS-compatible at these versions
const ora   = require('ora');
const chalk = require('chalk');

const { createOAuth2Client, getAuthUrl, getTokens, setCredentials } = require('./auth');
const { downloadByAlbums, downloadByDate, downloadAll } = require('./downloader');

const TOKEN_PATH = path.join(__dirname, '..', '.tokens.json');

async function getClient() {
  const oAuth2Client = createOAuth2Client();

  // Try to load saved tokens
  if (await fs.pathExists(TOKEN_PATH)) {
    const tokens = await fs.readJson(TOKEN_PATH);
    setCredentials(oAuth2Client, tokens);

    // Persist refreshed tokens automatically
    oAuth2Client.on('tokens', async (newTokens) => {
      const existing = await fs.readJson(TOKEN_PATH).catch(() => ({}));
      await fs.writeJson(TOKEN_PATH, { ...existing, ...newTokens }, { spaces: 2 });
    });

    return oAuth2Client;
  }

  // Interactive OAuth flow
  const url = getAuthUrl(oAuth2Client);
  console.log(chalk.cyan('\nOpen this URL in your browser to authorize:\n'));
  console.log(chalk.yellow(url));
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(resolve => rl.question('Paste the authorization code here: ', (ans) => { rl.close(); resolve(ans.trim()); }));

  const tokens = await getTokens(oAuth2Client, code);
  setCredentials(oAuth2Client, tokens);
  await fs.writeJson(TOKEN_PATH, tokens, { spaces: 2 });
  console.log(chalk.green('\n✅ Tokens saved to .tokens.json\n'));

  return oAuth2Client;
}

async function main() {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'all';

  if (!['all', 'albums', 'date'].includes(mode)) {
    console.error(chalk.red(`Unknown mode "${mode}". Use: all | albums | date`));
    process.exit(1);
  }

  console.log(chalk.bold(`\n📷 Google Photos Downloader — mode: ${mode}\n`));

  const client = await getClient();
  const spinner = ora('Starting...').start();
  let count = 0;

  const onProgress = (event) => {
    if (event.type === 'phase')       { spinner.text = event.message; return; }
    if (event.type === 'album-start') { spinner.text = `📁 ${event.album}`; return; }
    if (event.type === 'error')       { spinner.warn(chalk.red(`Error: ${event.item} — ${event.error}`)); spinner.start(); return; }
    if (event.type === 'file' && !event.skipped) { count++; spinner.text = `✅ (${count}) ${event.item}`; }
  };

  try {
    let stats;
    if (mode === 'albums')      stats = await downloadByAlbums(client, onProgress);
    else if (mode === 'date')   stats = await downloadByDate(client, onProgress);
    else                        stats = await downloadAll(client, onProgress);

    spinner.succeed(chalk.green('Download complete!'));
    const dl = stats.totalDownloaded ?? stats.downloaded ?? 0;
    const sk = stats.totalSkipped    ?? stats.skipped    ?? 0;
    const er = stats.totalErrors     ?? stats.errors     ?? 0;
    console.log(`\n  Downloaded : ${chalk.green(dl)}`);
    console.log(`  Skipped    : ${chalk.gray(sk)}`);
    console.log(`  Errors     : ${er > 0 ? chalk.red(er) : chalk.gray(er)}`);
    console.log(`\n  Files saved to: ${chalk.cyan(process.env.DOWNLOAD_DIR || './downloads')}\n`);
  } catch (err) {
    spinner.fail(chalk.red('Download failed: ' + err.message));
    process.exit(1);
  }
}

main();
