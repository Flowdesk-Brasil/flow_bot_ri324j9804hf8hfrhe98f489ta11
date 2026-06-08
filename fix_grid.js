const fs = require('fs');
const file = 'site/components/dashboard/HostingWorkspace.tsx';
let code = fs.readFileSync(file, 'utf8');

// Replace min-[1580px] with xl inside HostingPlanCard
// Let's just replace all min-[1580px] with xl since the only other usage was the grid wrapper which we already changed to xl!
code = code.replace(/min-\[1580px\]/g, 'xl');

// Fix gap-y to have md:gap-y-[64px]
// The current string is: className="grid w-full max-w-[372px] grid-cols-1 items-start justify-items-center gap-x-[12px] gap-y-[26px] md:max-w-[756px] md:grid-cols-2 xl:max-w-none xl:grid-cols-3 xl:justify-items-stretch"
code = code.replace(
  'gap-y-[26px] md:max-w-[756px]', 
  'gap-y-[26px] md:gap-y-[64px] xl:gap-y-[72px] md:max-w-[756px]'
);

fs.writeFileSync(file, code);
console.log('Grid fixed!');
