import { performance } from 'node:perf_hooks';
import { runDoctorProbes } from '../packages/cli/src/doctor.js';

async function benchmark() {
  const t0 = performance.now();
  const report = await runDoctorProbes();
  const elapsed = performance.now() - t0;

  console.log(`Cold start probe duration: ${elapsed.toFixed(2)} ms (budget < 2000 ms)`);
  if (elapsed > 2000) {
    console.warn(`WARNING: Cold start exceeded 2000ms budget`);
  } else {
    console.log(`Cold start benchmark PASSED.`);
  }
}

benchmark();
