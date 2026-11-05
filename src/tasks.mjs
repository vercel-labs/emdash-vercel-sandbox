import fs from 'node:fs/promises';
import { assetPath } from './paths.mjs';
import { openSshCommandChannel } from './ssh-command.mjs';
import { validateExportSelection } from './export.mjs';
import { shellQuote } from './ssh-config.mjs';

export async function listTasks(options) {
  const helper = await fs.readFile(assetPath('list-worktrees.py'), 'utf8');
  const connection = await openSshCommandChannel(options);
  try {
    const result = await connection.exec('python3 -c ' + shellQuote(helper), 60000);
    const tasks = JSON.parse(result.stdout);
    if (!Array.isArray(tasks) || tasks.length > 1000) throw new Error('Invalid task list');
    return tasks.map(task => {
      validateExportSelection(task.path);
      if (task.branch !== null && typeof task.branch !== 'string') throw new Error('Invalid task branch');
      return task;
    });
  } finally { connection.close(); }
}
