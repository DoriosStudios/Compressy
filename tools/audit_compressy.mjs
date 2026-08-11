import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const jsonPaths = await listFiles(root, ".json", new Set(["node_modules", "build", "builds", "artifacts", ".git", ".regolith"]));
const documents = new Map();
for (const path of jsonPaths) {
  try {
    documents.set(path, JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    errors.push(`${relative(path)} is not valid JSON: ${error.message}`);
  }
}

const blocks = collectDefinitions("BP/blocks/compressed", "minecraft:block");
const items = collectDefinitions("BP/items/compressed_items", "minecraft:item");
const allContent = new Set([...blocks.keys(), ...items.keys()]);

const contentManifest = documentAt("tools/content_manifest.json");
compareSets(new Set(contentManifest.block_identifiers ?? []), new Set(blocks.keys()), "content manifest blocks", "BP blocks");
compareSets(new Set(contentManifest.item_identifiers ?? []), new Set(items.keys()), "content manifest items", "BP items");

const blockCompress = collectRecipes("BP/recipes/compressed/blocks/compress");
const blockDecompress = collectRecipes("BP/recipes/compressed/blocks/decompress");
const itemCompress = collectRecipes("BP/recipes/compressed/items", path => path.includes("/compress/"));
const itemDecompress = collectRecipes("BP/recipes/compressed/items", path => path.includes("/decompress/"));

for (const identifier of blocks.keys()) {
  const compressionCount = blockCompress.filter(recipe => recipe.result === identifier).length;
  const decompressionCount = blockDecompress.filter(recipe => recipe.ingredients.includes(identifier)).length;
  if (compressionCount !== 1) errors.push(`${identifier} has ${compressionCount} compression recipes; expected 1`);
  if (decompressionCount !== 1) errors.push(`${identifier} has ${decompressionCount} decompression recipes; expected 1`);
}
for (const identifier of items.keys()) {
  const compressionCount = itemCompress.filter(recipe => recipe.result === identifier).length;
  const decompressionCount = itemDecompress.filter(recipe => recipe.ingredients.includes(identifier)).length;
  if (compressionCount !== 1) errors.push(`${identifier} has ${compressionCount} compression recipes; expected 1`);
  if (decompressionCount !== 1) errors.push(`${identifier} has ${decompressionCount} decompression recipes; expected 1`);
}

for (const recipe of blockCompress) {
  if (!blocks.has(recipe.result)) errors.push(`Block compression recipe produces excluded content: ${recipe.result}`);
  for (const ingredient of recipe.ingredients) {
    if (!ingredient.startsWith("minecraft:") && !blocks.has(ingredient)) {
      errors.push(`Block compression recipe uses non-vanilla excluded input: ${ingredient}`);
    }
  }
}
for (const recipe of itemCompress) {
  for (const ingredient of recipe.ingredients) {
    if (!ingredient.startsWith("minecraft:") && !items.has(ingredient)) {
      errors.push(`Item compression recipe uses non-vanilla excluded input: ${ingredient}`);
    }
  }
}

const terrain = documentAt("RP/textures/terrain_texture.json").texture_data ?? {};
for (const [identifier, block] of blocks) {
  const materials = block.components?.["minecraft:material_instances"] ?? {};
  for (const material of Object.values(materials)) {
    if (!material?.texture) continue;
    const entry = terrain[material.texture];
    if (!entry) errors.push(`${identifier} uses missing terrain key ${material.texture}`);
    else checkTextureEntry(entry, `terrain key ${material.texture}`);
  }
}

const itemTextures = documentAt("RP/textures/item_texture.json").texture_data ?? {};
for (const [identifier, item] of items) {
  const icon = item.components?.["minecraft:icon"];
  const key = typeof icon === "string" ? icon : icon?.texture;
  const entry = itemTextures[key];
  if (!entry) errors.push(`${identifier} uses missing item texture key ${key}`);
  else checkTextureEntry(entry, `item texture key ${key}`);
}

const sounds = documentAt("RP/blocks.json");
for (const identifier of blocks.keys()) {
  if (!sounds[identifier]?.sound) errors.push(`Missing sound mapping for ${identifier}`);
}

const catalogIds = new Set();
const catalog = documentAt("BP/item_catalog/crafting_item_catalog.json");
visit(catalog, value => {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.includes(":")) catalogIds.add(item);
      else if (item?.name) catalogIds.add(item.name);
    }
  }
});
for (const identifier of allContent) {
  if (!catalogIds.has(identifier)) errors.push(`Creative catalog is missing ${identifier}`);
}

const languageFiles = (await listFiles(join(root, "RP/texts"), ".lang")).sort();
if (!languageFiles.length) errors.push("No resource-pack localization files found");
for (const path of languageFiles) {
  const localization = await readFile(path, "utf8");
  if (/(?:^|[\\\\/])es_(ES|MX)\.lang$/.test(path) && localization.includes("?")) {
    errors.push(`${relative(path)} contains a damaged Spanish character`);
  }
  const keys = new Set(localization.split(/\r?\n/).map(line => line.split("=", 1)[0]));
  for (const identifier of blocks.keys()) {
    if (!keys.has(`tile.${identifier}.name`)) errors.push(`${relative(path)} is missing ${identifier}`);
  }
  for (const identifier of items.keys()) {
    if (!keys.has(`item.${identifier}`) && !keys.has(`item.${identifier}.name`)) errors.push(`${relative(path)} is missing ${identifier}`);
  }
}

const bpManifest = documentAt("BP/manifest.json");
const rpManifest = documentAt("RP/manifest.json");
const packageJson = documentAt("package.json");
const expectedVersion = [1, 0, 2];
checkVersion(bpManifest.header?.version, expectedVersion, "BP header");
checkVersion(rpManifest.header?.version, expectedVersion, "RP header");
if (packageJson.version !== expectedVersion.join(".")) errors.push("package.json version does not match 1.0.2");
for (const module of [...(bpManifest.modules ?? []), ...(rpManifest.modules ?? [])]) {
  checkVersion(module.version, [1, 0, 0], `${module.type} module`);
}
const bpPackDependency = (bpManifest.dependencies ?? []).find(value => value.uuid === rpManifest.header?.uuid);
const rpPackDependency = (rpManifest.dependencies ?? []).find(value => value.uuid === bpManifest.header?.uuid);
checkVersion(bpPackDependency?.version, expectedVersion, "BP to RP dependency");
checkVersion(rpPackDependency?.version, expectedVersion, "RP to BP dependency");

if (errors.length) {
  console.error(`Compressy audit failed with ${errors.length} issue(s):`);
  errors.sort().forEach(error => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Compressy audit passed: ${blocks.size} vanilla-derived blocks and ${items.size} compressed items.`);
}

async function listFiles(directory, extension = "", ignored = new Set()) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path, extension, ignored));
    else if (!extension || extname(path) === extension) result.push(path);
  }
  return result;
}

function relative(path) {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}

function documentAt(path) {
  const document = documents.get(join(root, path));
  if (!document) {
    errors.push(`Missing or invalid ${path}`);
    return {};
  }
  return document;
}

function collectDefinitions(directory, rootKey) {
  const result = new Map();
  for (const [path, document] of documents) {
    if (!relative(path).startsWith(`${directory}/`)) continue;
    const body = document[rootKey];
    const identifier = body?.description?.identifier;
    if (!identifier) errors.push(`${relative(path)} has no identifier`);
    else if (result.has(identifier)) errors.push(`Duplicate definition for ${identifier}`);
    else result.set(identifier, body);
  }
  return result;
}

function collectRecipes(directory, predicate = () => true) {
  const result = [];
  for (const [path, document] of documents) {
    const normalized = relative(path);
    if (!normalized.startsWith(`${directory}/`) || !predicate(normalized)) continue;
    const body = Object.entries(document).find(([key]) => key.startsWith("minecraft:recipe_"))?.[1];
    if (!body) {
      errors.push(`${normalized} has no recipe body`);
      continue;
    }
    const ingredients = body.ingredients
      ? body.ingredients.map(value => value.item).filter(Boolean)
      : body.key
        ? Object.values(body.key).map(value => value.item).filter(Boolean)
        : [];
    const output = typeof body.result === "string" ? body.result : body.result?.item;
    result.push({ path: normalized, ingredients: [...new Set(ingredients)], result: output });
  }
  return result;
}

function compareSets(expected, actual, expectedName, actualName) {
  for (const value of expected) if (!actual.has(value)) errors.push(`${actualName} missing ${value} from ${expectedName}`);
  for (const value of actual) if (!expected.has(value)) errors.push(`${actualName} contains ${value} absent from ${expectedName}`);
}

function checkTextureEntry(entry, context) {
  const textures = Array.isArray(entry.textures) ? entry.textures : [entry.textures];
  for (const texture of textures.filter(Boolean)) {
    if (!existsSync(join(root, "RP", `${texture}.png`))) errors.push(`${context} points to missing ${texture}.png`);
  }
}

function visit(value, callback) {
  callback(value);
  if (Array.isArray(value)) value.forEach(entry => visit(entry, callback));
  else if (value && typeof value === "object") Object.values(value).forEach(entry => visit(entry, callback));
}

function checkVersion(actual, expected, context) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`${context} version is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
