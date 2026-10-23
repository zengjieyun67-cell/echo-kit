// electron-builder afterPack hook: on Windows builds made from Linux/macOS (signAndEditExecutable is off, so no
// rcedit/wine), write the app icon and version strings into <App>.exe with resedit (pure JS).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const name = ctx.packager.appInfo.productFilename, version = ctx.packager.appInfo.version;
  const exePath = join(ctx.appOutDir, `${name}.exe`);
  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(readFileSync(join(ctx.packager.projectDir, 'build', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups[0]?.id ?? 1, lang = groups[0]?.lang ?? 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const [a, b, c] = version.split('.').map(Number);
    vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: name, FileDescription: name, CompanyName: 'Jieyun Zeng', ProductVersion: version, FileVersion: version, OriginalFilename: `${name}.exe`, InternalName: name });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • afterPack: icon + version written into ${name}.exe (resource group ${id})`);
}
