import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const directory = new URL('../dist/screen-text-data/', import.meta.url);
await mkdir(directory, { recursive: true });
await Promise.all(['eng', 'chi_sim', 'chi_tra'].map((language) => {
  const filename = `${language}.traineddata.gz`;
  return copyFile(
    require.resolve(`@tesseract.js-data/${language}/4.0.0_best_int/${filename}`),
    new URL(filename, directory),
  );
}));
