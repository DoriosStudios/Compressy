# Compressy

Compressy is a standalone Minecraft Bedrock add-on for compact storage. It includes compressed variants of vanilla blocks plus compact forms for common items such as dyes, seeds, rods, mob drops, paper, string, and sticks.

Most block families have four compression tiers. Cobblestone continues through nine tiers, up to Nonuple Compressed Cobblestone.

## Compatibility

- Minecraft Bedrock 1.21.120 or newer.
- No experiments, scripts, or external add-on dependencies are required.
- Existing `utilitycraft:` identifiers and the published Compressy pack UUIDs are intentionally preserved so worlds can update from earlier Compressy releases.
- Compressy is intended as a standalone alternative to UtilityCraft. Do not enable both packs in the same world because they share content identifiers.

## Development

This is a [Regolith](https://github.com/Bedrock-OSS/regolith) project.

```sh
npm ci
npm test
regolith run buildDev
regolith run buildMinify
```

The generated content is synchronized from the sibling UtilityCraft checkout:

```sh
npm run sync:utilitycraft
```

The synchronizer follows only compression chains rooted in `minecraft:` block identifiers. UtilityCraft-only ores, metals, crushed materials, and other custom block families are excluded automatically. Compressed items are synchronized as a complete standalone set.

## Releases

Publishing a GitHub Release triggers `.github/workflows/build.yml`. The workflow builds development and minified `.mcaddon` files, attaches both to the release, and uploads the minified artifact to CurseForge project `1387104`.
