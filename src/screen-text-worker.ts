import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { createWorker, OEM, PSM } from 'tesseract.js';
import type { ScreenTextLine } from './screen-text.js';

const { image, width, height } = workerData as { image: Uint8Array; width: number; height: number };
const worker = await createWorker(['eng', 'chi_sim', 'chi_tra'], OEM.LSTM_ONLY, {
  langPath: fileURLToPath(new URL('./screen-text-data/', import.meta.url)),
  cacheMethod: 'none',
});
const lines: ScreenTextLine[] = [];
try {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  const { data } = await worker.recognize(Buffer.from(image), {}, { text: false, blocks: true });
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const { text, confidence, bbox } of paragraph.lines) {
        lines.push({
          text: text.trim(),
          confidence: confidence / 100,
          x: (bbox.x0 + bbox.x1) / (2 * width),
          y: (bbox.y0 + bbox.y1) / (2 * height),
        });
      }
    }
  }
} finally {
  await worker.terminate();
}
parentPort!.postMessage(lines);
