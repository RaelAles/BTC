#!/usr/bin/env node
/* Gera os PNGs da PWA a partir do vetor public/icon.svg (npm run icons).

   O vetor traz o selo redondo, com cantos transparentes, usado no atalho
   instalado no Linux. As demais variantes saem do mesmo desenho:
   - icon-192/icon-512: selo redondo (cantos transparentes);
   - icon-maskable-512: fundo de borda cheia e desenho dentro da zona segura
     de 80% de diâmetro, como o maskable exige;
   - apple-touch-icon: 180x180 opaco (o iOS arredonda por conta própria) com o
     desenho dentro da área que a máscara não corta.

   A rasterização usa o Chromium headless, sem dependência de npm. Aponte
   CHROME=/caminho/do/binário se o navegador não estiver no PATH. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const FONTE = join(RAIZ, 'public/icon.svg');

/* Caixa nativa do desenho no viewBox 0 0 38.376 38.375 do símbolo
   favicon-marca: o traço ocupa a largura toda e fica centrado verticalmente
   (y de 0,9 a 37,4). O raio usa o canto da caixa, então é conservador. */
const ARTE = { largura: 38.376, altura: 36.5, centro: [19.188, 19.1875] };
const RAIO = Math.hypot(ARTE.largura, ARTE.altura) / 2;

const svg = readFileSync(FONTE, 'utf8');
const desenho = svg.match(/<path[^>]*\sd="([^"]+)"/)[1];
const FUNDO = svg.match(/<circle[^>]*fill="([^"]+)"/)[1];
const MARCA = svg.match(/<g[^>]*fill="([^"]+)"/)[1];

function icone(tamanho, raioAlvo, { redondo }) {
  const escala = raioAlvo / RAIO;
  const base = redondo
    ? `<circle cx="${tamanho / 2}" cy="${tamanho / 2}" r="${tamanho / 2}" fill="${FUNDO}"/>`
    : `<rect width="${tamanho}" height="${tamanho}" fill="${FUNDO}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tamanho}" height="${tamanho}" viewBox="0 0 ${tamanho} ${tamanho}">
${base}
<g fill="${MARCA}" transform="translate(${tamanho / 2} ${tamanho / 2}) scale(${escala}) translate(-${ARTE.centro[0]} -${ARTE.centro[1]})"><path d="${desenho}"/></g>
</svg>
`;
}

/* raio = distância máxima do desenho ao centro, em pixels do ícone */
const ALVOS = [
  { arquivo: 'icon-512.png', tamanho: 512, raio: 0.86 * 256, redondo: true },
  { arquivo: 'icon-192.png', tamanho: 192, raio: 0.86 * 96, redondo: true },
  { arquivo: 'icon-maskable-512.png', tamanho: 512, raio: 0.39 * 512, redondo: false },
  { arquivo: 'apple-touch-icon.png', tamanho: 180, raio: 0.40 * 180, redondo: false },
];

const NAVEGADORES = [process.env.CHROME, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  .filter(Boolean);

function navegador() {
  for (const bin of NAVEGADORES) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch { /* tenta o próximo */ }
  }
  throw new Error('Chromium não encontrado; defina CHROME=/caminho/do/binário');
}

const bin = navegador();
const temporario = mkdtempSync(join(tmpdir(), 'icones-'));

try {
  for (const alvo of ALVOS) {
    const svgTemp = join(temporario, alvo.arquivo.replace(/\.png$/, '.svg'));
    const pngTemp = join(temporario, alvo.arquivo);
    writeFileSync(svgTemp, icone(alvo.tamanho, alvo.raio, { redondo: alvo.redondo }));
    execFileSync(bin, [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${alvo.tamanho},${alvo.tamanho}`,
      `--screenshot=${pngTemp}`,
      `file://${svgTemp}`,
    ], { stdio: 'ignore' });
    const png = readFileSync(pngTemp);
    const largura = png.readUInt32BE(16);
    const altura = png.readUInt32BE(20);
    if (largura !== alvo.tamanho || altura !== alvo.tamanho) {
      throw new Error(`${alvo.arquivo}: ${largura}x${altura} em vez de ${alvo.tamanho}x${alvo.tamanho}`);
    }
    writeFileSync(join(RAIZ, 'public', alvo.arquivo), png);
    console.log(`ok   public/${alvo.arquivo} (${largura}x${altura})`);
  }
} finally {
  rmSync(temporario, { recursive: true, force: true });
}
