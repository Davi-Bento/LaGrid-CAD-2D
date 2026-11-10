const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// URL do editor calculada a partir da localização do repositório.
const appUrl = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

// Pasta para screenshots gerados pelos testes (ignorada pelo git).
const artifactsDir = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

module.exports = { appUrl, artifactsDir };
