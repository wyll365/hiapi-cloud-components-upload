import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    splitting: false,
    clean: true,
    target: 'node14',
    sourcemap: false,
    outExtension: ({ format }) => {
        if (format === 'cjs') return { js: '.cjs.js' }
        if (format === 'esm') return { js: '.esm.js' }
        return {}
    },
})