import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(process.argv[2] ?? join(projectRoot, "..", "UtilityCraft"));

const generatedPaths = [
  "BP/blocks/compressed",
  "BP/items/compressed_items",
  "BP/item_catalog",
  "BP/loot_tables/compressed",
  "BP/recipes/compressed",
  "RP/block_culling",
  "RP/models/blocks",
  "RP/texts",
  "RP/textures/blocks/compressed",
  "RP/textures/items/compressed_items"
];

const sourceFiles = {
  blocks: "BP/blocks/compressed",
  blockCompressRecipes: "BP/recipes/compressed/blocks/compress",
  blockDecompressRecipes: "BP/recipes/compressed/blocks/decompress",
  compressedItems: "BP/items/compressed_items",
  itemRecipes: "BP/recipes/compressed/items",
  itemCatalog: "BP/item_catalog/crafting_item_catalog.json",
  terrain: "RP/textures/terrain_texture.json",
  itemTextures: "RP/textures/item_texture.json",
  sounds: "RP/blocks.json",
  texts: "RP/texts"
};

await assertSource();
for (const path of generatedPaths) await rm(join(projectRoot, path), { recursive: true, force: true });

const compressionRecipes = await readRecipeDirectory(sourceFiles.blockCompressRecipes);
const vanillaRoots = compressionRecipes.filter(({ recipe }) =>
  recipe.result?.includes("compressed") &&
  recipe.ingredients.length > 0 &&
  recipe.ingredients.every(identifier => identifier.startsWith("minecraft:"))
);

const selectedBlockIds = new Set(vanillaRoots.map(({ recipe }) => recipe.result));
let changed = true;
while (changed) {
  changed = false;
  for (const { recipe } of compressionRecipes) {
    if (!recipe.result?.includes("compressed") || selectedBlockIds.has(recipe.result)) continue;
    if (recipe.ingredients.length > 0 && recipe.ingredients.every(identifier => selectedBlockIds.has(identifier))) {
      selectedBlockIds.add(recipe.result);
      changed = true;
    }
  }
}

const blockDocuments = [];
for (const path of await listFiles(join(sourceRoot, sourceFiles.blocks), ".json")) {
  const document = await readJson(path);
  const identifier = document["minecraft:block"]?.description?.identifier;
  if (!selectedBlockIds.has(identifier)) continue;
  blockDocuments.push({ identifier, document, source: path });
  await writeJson(join(projectRoot, relative(sourceRoot, path)), document, "\t");
}

const foundBlockIds = new Set(blockDocuments.map(({ identifier }) => identifier));
assertSetEqual(selectedBlockIds, foundBlockIds, "selected recipe outputs", "block definitions");

for (const entry of compressionRecipes) {
  if (selectedBlockIds.has(entry.recipe.result)) {
    await copyRelative(entry.path, join(sourceRoot, sourceFiles.blockCompressRecipes));
  }
}

const decompressionRecipes = await readRecipeDirectory(sourceFiles.blockDecompressRecipes);
const preferredDecompression = new Map();
for (const entry of decompressionRecipes) {
  const identifier = entry.recipe.ingredients.find(value => selectedBlockIds.has(value));
  if (!identifier) continue;
  const current = preferredDecompression.get(identifier);
  const isLegacy = basename(entry.path).includes("_to_");
  const currentIsLegacy = current ? basename(current.path).includes("_to_") : true;
  if (!current || (currentIsLegacy && !isLegacy)) preferredDecompression.set(identifier, entry);
}
for (const entry of preferredDecompression.values()) {
  await copyRelative(entry.path, join(sourceRoot, sourceFiles.blockDecompressRecipes));
}

const selectedItemIds = new Set();
for (const path of await listFiles(join(sourceRoot, sourceFiles.compressedItems), ".json")) {
  const document = await readJson(path);
  const identifier = document["minecraft:item"]?.description?.identifier;
  if (!identifier) throw new Error(`Compressed item has no identifier: ${relative(sourceRoot, path)}`);
  selectedItemIds.add(identifier);
  await copyRelative(path, join(sourceRoot, sourceFiles.compressedItems));
}
await copyTree(join(sourceRoot, sourceFiles.itemRecipes), join(projectRoot, sourceFiles.itemRecipes));

const selectedContentIds = new Set([...selectedBlockIds, ...selectedItemIds]);
await copyMatchingLootTables(selectedContentIds);

const terrainSource = await readJson(join(sourceRoot, sourceFiles.terrain));
const terrainKeys = collectBlockTextureKeys(blockDocuments);
const terrain = {
  num_mip_levels: terrainSource.num_mip_levels ?? 4,
  padding: terrainSource.padding ?? 8,
  resource_pack_name: "Compressy",
  texture_name: "atlas.terrain",
  texture_data: pickEntries(terrainSource.texture_data, terrainKeys, "terrain texture")
};
await writeJson(join(projectRoot, sourceFiles.terrain), terrain, "\t");
await copyAtlasTextures(terrain.texture_data);

const itemTextureSource = await readJson(join(sourceRoot, sourceFiles.itemTextures));
const itemTextureKeys = await collectItemTextureKeys();
const itemTextures = {
  resource_pack_name: "Compressy",
  texture_name: "atlas.items",
  texture_data: pickEntries(itemTextureSource.texture_data, itemTextureKeys, "item texture")
};
await writeJson(join(projectRoot, sourceFiles.itemTextures), itemTextures, "\t");
await copyAtlasTextures(itemTextures.texture_data);

const catalogSource = await readJson(join(sourceRoot, sourceFiles.itemCatalog));
const catalog = filterCatalog(catalogSource, selectedContentIds);
await writeJson(join(projectRoot, sourceFiles.itemCatalog), catalog, 4);

const soundMap = parseSimpleSounds(await readFile(join(sourceRoot, sourceFiles.sounds), "utf8"));
const sounds = { format_version: "1.1.0" };
for (const identifier of [...selectedBlockIds].sort()) {
  const sound = soundMap.get(identifier);
  if (!sound) throw new Error(`Missing sound mapping for ${identifier}`);
  sounds[identifier] = { sound };
}
await writeJson(join(projectRoot, sourceFiles.sounds), sounds, "\t");

await copyRequiredGeometry(blockDocuments);
await writeLocalizations(selectedContentIds, catalog);
await normalizeGeneratedJson();

const manifest = {
  schema_version: 1,
  source: "../UtilityCraft",
  vanilla_block_families: vanillaRoots
    .map(({ recipe }) => ({ source_item: recipe.ingredients[0], first_tier: recipe.result }))
    .sort((a, b) => a.first_tier.localeCompare(b.first_tier)),
  block_identifiers: [...selectedBlockIds].sort(),
  item_identifiers: [...selectedItemIds].sort()
};
await writeJson(join(projectRoot, "tools/content_manifest.json"), manifest, 2);

console.log(`Synchronized ${manifest.vanilla_block_families.length} vanilla block families (${selectedBlockIds.size} blocks).`);
console.log(`Synchronized ${selectedItemIds.size} compressed items.`);

async function assertSource() {
  const missing = Object.values(sourceFiles)
    .map(path => join(sourceRoot, path))
    .filter(path => !existsSync(path));
  if (missing.length) throw new Error(`UtilityCraft source is incomplete:\n${missing.join("\n")}`);
}

async function listFiles(directory, extension = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path, extension));
    else if (!extension || extname(path) === extension) result.push(path);
  }
  return result.sort();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value, indentation = 2) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, indentation)}\n`, "utf8");
}

function getRecipe(document, path) {
  const recipe = Object.entries(document).find(([key]) => key.startsWith("minecraft:recipe_"))?.[1];
  if (!recipe) throw new Error(`No recipe body in ${relative(sourceRoot, path)}`);
  const ingredients = recipe.ingredients
    ? recipe.ingredients.map(value => value.item).filter(Boolean)
    : recipe.key
      ? Object.values(recipe.key).map(value => value.item).filter(Boolean)
      : [];
  const result = typeof recipe.result === "string" ? recipe.result : recipe.result?.item;
  return { ingredients: [...new Set(ingredients)], result };
}

async function readRecipeDirectory(relativeDirectory) {
  const directory = join(sourceRoot, relativeDirectory);
  const entries = [];
  for (const path of await listFiles(directory, ".json")) {
    entries.push({ path, document: await readJson(path) });
  }
  return entries.map(entry => ({ ...entry, recipe: getRecipe(entry.document, entry.path) }));
}

async function copyRelative(source, base) {
  const relativePath = relative(sourceRoot, source);
  const destination = join(projectRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function copyTree(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

function assertSetEqual(expected, actual, expectedName, actualName) {
  const missing = [...expected].filter(value => !actual.has(value));
  const extra = [...actual].filter(value => !expected.has(value));
  if (missing.length || extra.length) {
    throw new Error(`${expectedName} and ${actualName} differ. Missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`);
  }
}

function collectBlockTextureKeys(blocks) {
  const result = new Set();
  for (const { document } of blocks) {
    const materials = document["minecraft:block"]?.components?.["minecraft:material_instances"] ?? {};
    for (const material of Object.values(materials)) {
      if (typeof material?.texture === "string") result.add(material.texture);
    }
  }
  return result;
}

async function collectItemTextureKeys() {
  const result = new Set();
  for (const path of await listFiles(join(projectRoot, sourceFiles.compressedItems), ".json")) {
    const document = await readJson(path);
    const icon = document["minecraft:item"]?.components?.["minecraft:icon"];
    const texture = typeof icon === "string" ? icon : icon?.texture;
    if (texture) result.add(texture);
  }
  return result;
}

function pickEntries(source, keys, description) {
  const result = {};
  for (const key of [...keys].sort()) {
    if (!source[key]) throw new Error(`Missing ${description} entry: ${key}`);
    result[key] = source[key];
  }
  return result;
}

async function copyAtlasTextures(entries) {
  for (const entry of Object.values(entries)) {
    const values = Array.isArray(entry.textures) ? entry.textures : [entry.textures];
    for (const value of values.filter(Boolean)) {
      const source = join(sourceRoot, "RP", `${value}.png`);
      const destination = join(projectRoot, "RP", `${value}.png`);
      if (!existsSync(source)) throw new Error(`Missing atlas image: ${relative(sourceRoot, source)}`);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
    }
  }
}

async function copyMatchingLootTables(selectedIds) {
  const sourceDirectory = join(sourceRoot, "BP/loot_tables/compressed");
  if (!existsSync(sourceDirectory)) return;
  for (const path of await listFiles(sourceDirectory, ".json")) {
    const text = await readFile(path, "utf8");
    if ([...selectedIds].some(identifier => text.includes(`\"${identifier}\"`))) {
      await copyRelative(path, sourceDirectory);
    }
  }
}

function filterCatalog(source, selectedIds) {
  const body = source["minecraft:crafting_items_catalog"];
  const categories = [];
  const cataloged = new Set();
  for (const category of body.categories ?? []) {
    const groups = [];
    for (const group of category.groups ?? []) {
      const items = (group.items ?? []).filter(item =>
        typeof item === "string" ? selectedIds.has(item) : selectedIds.has(item?.name)
      );
      if (items.length) {
        for (const item of items) cataloged.add(typeof item === "string" ? item : item.name);
        groups.push({ ...group, items });
      }
    }
    if (groups.length) categories.push({ ...category, groups });
  }

  const missing = [...selectedIds].filter(identifier => !cataloged.has(identifier)).sort();
  if (missing.length) {
    const bundleGroup = categories
      .flatMap(category => category.groups)
      .find(group => group.group_identifier?.name === "dorios:itemGroup.name.bundles");
    if (!bundleGroup) throw new Error(`Cannot place uncatalogued compressed content: ${missing.join(", ")}`);
    bundleGroup.items.push(...missing);
  }
  return {
    format_version: source.format_version,
    "minecraft:crafting_items_catalog": { categories }
  };
}

function parseSimpleSounds(text) {
  const result = new Map();
  const pattern = /"(?<identifier>[a-z0-9_.-]+:[a-z0-9_./-]+)"\s*:\s*\{\s*"sound"\s*:\s*"(?<sound>[^"]+)"/g;
  for (const match of text.matchAll(pattern)) result.set(match.groups.identifier, match.groups.sound);
  return result;
}

async function copyRequiredGeometry(blocks) {
  const needsGlass = blocks.some(({ document }) => {
    const geometry = document["minecraft:block"]?.components?.["minecraft:geometry"];
    return geometry?.identifier === "geometry.utilitycraft_glass";
  });
  if (!needsGlass) return;
  for (const path of ["RP/models/blocks/glass.geo.json", "RP/block_culling/glass.json"]) {
    const source = join(sourceRoot, path);
    const destination = join(projectRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

async function normalizeGeneratedJson() {
  for (const relativeDirectory of generatedPaths) {
    const directory = join(projectRoot, relativeDirectory);
    if (!existsSync(directory)) continue;
    for (const path of await listFiles(directory, ".json")) {
      await writeJson(path, await readJson(path), "\t");
    }
  }
}

async function writeLocalizations(selectedIds, catalog) {
  const groupNames = new Set();
  for (const category of catalog["minecraft:crafting_items_catalog"].categories) {
    for (const group of category.groups) {
      if (group.group_identifier?.name) groupNames.add(group.group_identifier.name);
    }
  }

  const sourceDirectory = join(sourceRoot, sourceFiles.texts);
  const destinationDirectory = join(projectRoot, sourceFiles.texts);
  await mkdir(destinationDirectory, { recursive: true });
  await cp(join(sourceDirectory, "languages.json"), join(destinationDirectory, "languages.json"));

  for (const path of await listFiles(sourceDirectory, ".lang")) {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    const selected = lines.filter(line => {
      const separator = line.indexOf("=");
      if (separator < 1) return false;
      const key = line.slice(0, separator);
      if (groupNames.has(key)) return true;
      return [...selectedIds].some(identifier =>
        key === `tile.${identifier}.name` || key === `item.${identifier}` || key === `item.${identifier}.name`
      );
    }).map(line => line
      .replaceAll("@UtilityCraft", "@Compressy")
      .replaceAll("cu?druplemente", "cuádruplemente")
      .replaceAll("bamb?", "bambú"));
    await writeFile(join(destinationDirectory, path.split(/[\\/]/).pop()), `${selected.join("\n")}\n`, "utf8");
  }
}
