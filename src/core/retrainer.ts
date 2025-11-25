import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { AUTO_TRAINING_CONFIG } from '../config/strategy';

// Run a Python training script in the background and capture stdout/stderr to a log file.
export function triggerRetrainIfNeeded(samplesFilePath: string) {
  try {
    if (!AUTO_TRAINING_CONFIG.enabled) return;

    // Check sample count quickly to avoid heavy runs when few samples
    if (!fs.existsSync(samplesFilePath)) return;
    const content = fs.readFileSync(samplesFilePath, 'utf8').trim().split('\n').filter(Boolean);
    const closedCount = content.reduce((sum, line) => {
      try { const obj = JSON.parse(line); return sum + ((obj?.result && typeof obj.result.profit !== 'undefined') ? 1 : 0); } catch { return sum; }
    }, 0);

    if (closedCount < (AUTO_TRAINING_CONFIG.minSamples ?? 10)) return;

    const projectRoot = path.join(__dirname, '..', '..');
    const pythonCmd = AUTO_TRAINING_CONFIG.pythonCommand || 'python';
    const trainScript = path.join(projectRoot, AUTO_TRAINING_CONFIG.trainScript || 'scripts/train_model.py');
    const modelOutput = path.join(projectRoot, AUTO_TRAINING_CONFIG.modelOutput || 'data/output/model.pkl');

    // spawn detached process so we don't block the bot
    const outLog = path.join(projectRoot, 'data', 'output', `train_${Date.now()}.log`);
    const args = [trainScript, '--input', path.join(projectRoot, 'data', 'output', 'trade_signals.jsonl'), '--output', modelOutput];

    const child = spawn(pythonCmd, args, {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    // detach and let it run; write a short log file to record invocation
    child.unref();
    fs.appendFileSync(outLog, `${new Date().toISOString()} spawned trainer: ${pythonCmd} ${args.join(' ')}\n`);
  } catch (err) {
    // don't let training failures affect trading
    // eslint-disable-next-line no-console
    console.warn('triggerRetrainIfNeeded error', (err as any)?.message ?? err);
  }
}

export default { triggerRetrainIfNeeded };
