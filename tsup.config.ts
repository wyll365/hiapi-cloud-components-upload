import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    splitting: false,
    clean: true,
    // 1. 明确标记为 node 平台
    platform: 'node',
    target: 'node16',
    // 2. 将所有 Node 原生模块和复杂的第三方依赖设为外部
    external: ['archiver', 'axios', 'form-data'], // 告诉 tsup 不要把这些代码打进 index.esm.js
    sourcemap: false,
    outExtension: ({ format }) => {
        if (format === 'cjs') return { js: '.cjs.js' }
        if (format === 'esm') return { js: '.esm.js' }
        return {}
    },
})