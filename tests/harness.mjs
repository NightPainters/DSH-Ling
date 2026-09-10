// Minimal test harness + tiny vm runner (zero deps).

let failures = 0;
let current = '';

export function ok(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`  ✗ [${current}] ${msg}`);
  }
}

export function eq(a, b, msg) {
  const same = Object.is(a, b) || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));
  if (!same) {
    failures += 1;
    console.error(`  ✗ [${current}] ${msg}\n      expect: ${JSON.stringify(b)}\n      actual: ${JSON.stringify(a)}`);
  }
}

export async function section(name, fn) {
  current = name;
  console.log(`▶ ${name}`);
}

export function summary() {
  if (failures) {
    console.error(`\n${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log('\n全部通过 ✓');
  }
}
