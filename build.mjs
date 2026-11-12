import fs from "node:fs";
import path from "node:path";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";

const SRC = "src/packs";
const DEST = "packs";
const packs = fs.readdirSync(SRC, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

const slugify = s => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function build() {
  for ( const pack of packs ) {
    await compilePack(path.join(SRC, pack), path.join(DEST, pack), { recursive: false });
    console.log(`packed ${pack}`);
  }
}

async function unpack() {
  for ( const pack of packs ) {
    const dir = path.join(SRC, pack);
    const names = new Map();
    for ( const f of fs.readdirSync(dir) ) {
      if ( f.endsWith(".json") ) names.set(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))._id, f);
    }
    const used = new Set(names.values());
    const transformName = doc => {
      if ( names.has(doc._id) ) return names.get(doc._id);
      if ( doc._key?.startsWith("!folders!") ) return `_folder_${doc._id}.json`;
      let name = `${slugify(doc.name) || doc._id}.json`;
      if ( used.has(name) ) name = `${slugify(doc.name)}-${doc._id}.json`;
      used.add(name);
      return name;
    };
    await extractPack(path.join(DEST, pack), dir, { clean: true, transformName });
    console.log(`unpacked ${pack}`);
  }
}

const command = process.argv[2] ?? "build";
if ( command === "build" ) await build();
else if ( command === "unpack" ) await unpack();
else {
  console.error("usage: node build.mjs build|unpack");
  process.exit(1);
}
