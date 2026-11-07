import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface EvalTask {
  id: string;
  name: string;
  category: string;
  difficulty: string;
}

export function runEvaluations(): { total: number; passed: number; rate: number } {
  const tasksPath = path.join(__dirname, 'tasks.json');
  const tasks: EvalTask[] = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));

  let passed = 0;
  for (const task of tasks) {
    // Verify each task has valid structure and metadata
    if (task.id && task.name && task.category) {
      passed++;
    }
  }

  const rate = (passed / tasks.length) * 100;
  return { total: tasks.length, passed, rate };
}

if (import.meta.url.endsWith(process.argv[1])) {
  const res = runEvaluations();
  console.log(`OpenSand Eval Suite: ${res.passed}/${res.total} tasks evaluated (${res.rate.toFixed(1)}% baseline)`);
}
