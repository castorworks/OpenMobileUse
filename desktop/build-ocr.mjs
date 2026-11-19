import { execFileSync } from 'node:child_process';

if (process.platform === 'darwin') {
  execFileSync(
    'xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-framework',
      'Foundation',
      '-framework',
      'Vision',
      '-framework',
      'CoreGraphics',
      'desktop/recognize-text.m',
      '-o',
      'dist/recognize-text',
    ],
    { stdio: 'inherit' },
  );
}
