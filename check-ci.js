const { execSync } = require('child_process');

try {
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const output = execSync(`curl -s -H "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/ALLENDE123X/dealinno/commits/${sha}/check-runs"`).toString();
  const json = JSON.parse(output);
  const runs = json.check_runs || [];
  console.log(`Found ${runs.length} check runs.`);
  
  let allCompleted = true;
  for (const run of runs) {
    console.log(`- [${run.name}] Status: ${run.status}, Conclusion: ${run.conclusion}`);
    if (run.status !== 'completed') {
      allCompleted = false;
    }
  }
  
  console.log(`\nAll Completed: ${allCompleted}`);
} catch (err) {
  console.error(err);
}
