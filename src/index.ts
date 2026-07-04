// @ts-ignore
import type {Plugin} from 'vite'
import fs from 'fs'
import path from 'path'
import axios, {type AxiosResponse} from 'axios'
import FormData from 'form-data'
import archiver from 'archiver'
import vm from 'vm'

export type Page = {
    path: string
    name: string
}

export interface Menu {
    menuId: number, //菜单id
    pid: number, //上级id
    label: string, //名称
    shortLabel: string, //简短名称
    langCode: string, //多语言编码
    icon: string, //图标
    secured: string, // 权限标识
    url: string,//网址呢
    accountType?: string,
    sort?: number,
}


//qiankun 微应用注册信息, 随发布上报,主应用据此动态 registerMicroApps
export interface MicroAppMeta {
    name: string, // qiankun 应用名,如 HiapiCloudVemAdmin
    activeRule: string, // 激活路由,如 /micro-apps/vem
}

export interface UploadPluginOptions {
    server: string; // 服务器上传地址，例如 https://api.example.com/upload
    project: string; // 项目名称
    appId?: string; // 可选鉴权 token
    appSecret?: string; // 可选鉴权 token
    files: string[]; // 默认 dist/index.umd.js
    pageDir?: string; // 页面目录
    componentDir?: string; // 组件目录
    disable?: boolean; //是否禁用上传
    version?: string; //插件版本
    remark?: string; //插件版本
    pages?: Page[],
    menus?: Menu[],
    micro?: MicroAppMeta, // 微应用注册信息(管理后台类应用必填)
    i18nDir?: string; // 语言包目录,默认 src/i18n,结构 <dir>/<lang>/*.json
    iconDir?: string; // 菜单图标 svg 目录,默认 src/assets/svg
}

interface UploadResponse<T> {
    code: number
    message: string
    data: T
}


function removeImports(filePath: string) {
    let content = fs.readFileSync(filePath, 'utf-8');
    content = content.replace(/HiapiCloudSchema/g, () => {
        return 'any';
    });
    content = content.replace(
        /^import\s+(\w+)\s+from\s+['"][^'"]+['"];?\s*$/gm,
        (match, name) => {
            return `const ${name} = null;`;
        }
    );
    content = content.replace(
        /^import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"];?\s*$/gm,
        (match, imports) => {
            const names = imports
                .split(',')
                .map(item => item.trim().split(/\s+as\s+/)[0]) // 处理 alias
                .filter(name => name);
            return names.map(name => `const ${name} = null;`).join('\n');
        }
    );

    content = content.replace(
        /^import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"];?\s*$/gm,
        (match, name) => {
            return `const ${name} = null;`;
        }
    );
    content = content.replace(/^export\s+(type|interface|class)\s+\w+\s*[\s\S]*?\}\s*;?\s*$/gm, '');
    content = content.replace(/^export\s+function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\}\s*$/gm, '');

// 再处理剩余的 export (兜底)
    content = content.replace(/^export\s+[\s\S]*?;?\s*$/gm, '');

    content = content.replace(/(const|let|var)\s+(\w+)\s*:\s*\w+\s*=/g, '$1 $2 =');
    content = content.replace(/(const|let|var)\s+(\w+)\s*:\s*[^=]+?\s*=/g, '$1 $2 =');

    content = content.replace(/import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*/g, '');
    content = content.replace(/import\s+\w+\s+from\s+['"][^'"]+['"];?\s*/g, '');
    content = content.replace(/import\s+['"][^'"]+['"];?\s*/g, '');
    content = content.replace(/import\s+type\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*/g, '');
    content = content.replace(/import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]+['"];?\s*/g, '');
    content = content.replace(/\n{3,}/g, '\n\n');
    content = content.replace(/^[ \t]+/gm, '');
    content += '\n\nmodule.exports = { widgetExport };';
    fs.writeFileSync(filePath, content, 'utf-8');
}


function getJsVariables(filePath: string) {
    const content = fs.readFileSync(filePath, 'utf-8');

    // 创建沙箱
    const sandbox = {
        module: {exports: {}},
    };

    // 执行代码（变量会写入 sandbox）
    vm.runInNewContext(content, sandbox);
    return sandbox.module.exports['widgetExport'];
}


function compressFolder(sourceDir: string, outputZip: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        // 创建输出流
        const output = fs.createWriteStream(outputZip);

        // 创建 archiver 实例
        const archive = archiver('zip', {
            zlib: {level: 9} // 压缩级别 0-9，9 为最高压缩
        });

        // 监听事件
        output.on('close', () => {
            console.log(`✅ 压缩完成：${outputZip}`);
            console.log(`📦 总大小：${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
            resolve();
        });

        archive.on('error', (err) => {
            console.error('❌ 压缩失败:', err);
            reject(err);
        });

        // 管道连接
        archive.pipe(output);

        // 添加整个目录
        archive.directory(sourceDir, false);

        // 完成压缩
        archive.finalize();
    });
}


//读取 <dir>/<lang>/*.json 聚合成 {lang: messages},与前端 import.meta.glob 扫描逻辑一致
function loadI18nMessages(i18nDir: string): Record<string, Record<string, any>> {
    const messages: Record<string, Record<string, any>> = {}
    for (const lang of fs.readdirSync(i18nDir)) {
        const langDir = path.join(i18nDir, lang)
        if (!fs.statSync(langDir).isDirectory()) continue
        messages[lang] = {}
        for (const file of fs.readdirSync(langDir)) {
            if (!file.endsWith('.json')) continue
            Object.assign(messages[lang], JSON.parse(fs.readFileSync(path.join(langDir, file), 'utf-8')))
        }
    }
    return messages
}

//按 vue-i18n 的点路径规则取值,如 menu.home → messages.menu.home
function resolveLangCode(messages: Record<string, any>, langCode: string): string | undefined {
    if (typeof messages[langCode] === 'string') return messages[langCode]
    let node: any = messages
    for (const part of langCode.split('.')) {
        if (node == null || typeof node !== 'object') return undefined
        node = node[part]
    }
    return typeof node === 'string' ? node : undefined
}

//把点路径 key 写回嵌套结构,保证 mergeLocaleMessage 后 t('a.b') 可命中
function setNested(target: Record<string, any>, langCode: string, value: string) {
    const parts = langCode.split('.')
    let node = target
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] == null) node[parts[i]] = {}
        node = node[parts[i]]
    }
    node[parts[parts.length - 1]] = value
}

/**
 * 从子应用语言包中抽取菜单 langCode 的翻译
 * 任一 langCode 在任一语言缺失 → 抛错终止发布(构建期强校验,防止翻译疏忽)
 */
export function extractMenuI18n(menus: Menu[], i18nDir: string): Record<string, Record<string, any>> {
    const messages = loadI18nMessages(i18nDir)
    const langs = Object.keys(messages)
    if (langs.length === 0) {
        throw new Error(`语言包目录为空: ${i18nDir}`)
    }
    const langCodes = [...new Set(menus.map(m => m.langCode).filter(Boolean))]
    const result: Record<string, Record<string, any>> = {}
    const missing: string[] = []
    for (const lang of langs) {
        result[lang] = {}
        for (const code of langCodes) {
            const text = resolveLangCode(messages[lang], code)
            if (text === undefined) {
                missing.push(`${lang}: ${code}`)
            } else {
                setNested(result[lang], code, text)
            }
        }
    }
    if (missing.length > 0) {
        throw new Error(`菜单翻译缺失,发布终止:\n  ${missing.join('\n  ')}`)
    }
    return result
}

/**
 * 收集菜单用到的自定义 svg 图标: {iconDir}/{icon}.svg 存在则内联上报
 * 不存在的视为 Element Plus 等主应用已注册的组件名,跳过
 */
export function collectMenuIcons(menus: Menu[], iconDir: string): Record<string, string> {
    const icons: Record<string, string> = {}
    for (const icon of new Set(menus.map(m => m.icon).filter(Boolean))) {
        const svgPath = path.join(iconDir, `${icon}.svg`)
        if (fs.existsSync(svgPath)) {
            icons[icon] = fs.readFileSync(svgPath, 'utf-8').trim()
        }
    }
    return icons
}

export function UploadPlugin(options: UploadPluginOptions): Plugin {
    const {server, appId, appSecret, files, version = '0.0.0', disable = false} = options

    if (!options.project) {
        throw new Error('请指定项目名')
    }


    return {
        name: 'vite-upload-plugin',
        apply: 'build',
        async closeBundle() {

            if (disable === true) {
                return //上传插件被禁用,
            }

            console.log(`\n📦  开始上传编译文件到服务器: ${server}`)

            //多个要打包上传的目录
            const distPaths = files.map(file => {
                return path.resolve(process.cwd(), file)
            })


            const pageDirPath: string | undefined = options.pageDir ? path.resolve(process.cwd(), `src/${options.pageDir}`) : undefined
            const componentDirPath: string | undefined = options.componentDir ? path.resolve(process.cwd(), `src/components/${options.componentDir}`) : undefined

            if (pageDirPath) {
                if (!fs.existsSync(pageDirPath)) {
                    console.error(`❌ 页面目录不存在: ${pageDirPath}`)
                    throw new Error(`页面目录不存在: ${pageDirPath}`)
                }
            }
            if (componentDirPath) {
                if (!fs.existsSync(componentDirPath)) {
                    console.error(`❌ 组件目录不存在: ${componentDirPath}`)
                    throw new Error(`组件目录不存在: ${componentDirPath}`)
                }
            }
            let zipDir: string | undefined = undefined
            let zipFile: string | undefined = undefined
            if (pageDirPath) {
                zipDir = path.resolve(process.cwd(), 'dist/zip')
                zipFile = path.resolve(process.cwd(), 'dist/zip.zip');
                if (!fs.existsSync(zipDir)) {
                    fs.mkdirSync(zipDir)
                } else {
                    fs.rmSync(zipDir, {recursive: true})
                    console.log('清理旧的zip目录完成')
                    fs.mkdirSync(zipDir)
                    console.log('创建新的zip目录完成')
                }
                if (fs.existsSync(zipFile)) {
                    fs.rmSync(zipFile, {recursive: true})
                }
            }


            if (pageDirPath) fs.cpSync(pageDirPath, path.resolve(process.cwd(), `dist/zip/${options.pageDir}`), {recursive: true});
            if (componentDirPath) fs.cpSync(componentDirPath, path.resolve(process.cwd(), `dist/zip/components/${options.componentDir}`), {recursive: true})
            if (componentDirPath) fs.cpSync(path.resolve(process.cwd(), `src/components/index.ts`), path.resolve(process.cwd(), `dist/zip/components/index.ts`), {recursive: true})
            if (componentDirPath) removeImports(path.resolve(process.cwd(), `dist/zip/components/index.ts`))
            let data: string | undefined = undefined;
            if (componentDirPath) {
                const widgetExport = getJsVariables(path.resolve(process.cwd(), `dist/zip/components/index.ts`))
                if (!widgetExport || Object.values(widgetExport).length === 0) {
                    throw new Error('组件模板数据为空')
                }
                fs.rmSync(path.resolve(process.cwd(), `dist/zip/components/index.ts`), {force: true, recursive: true})
                data = JSON.stringify(Object.values(widgetExport));
                fs.writeFileSync(path.resolve(process.cwd(), `dist/zip/components/index.json`), data, 'utf-8');
            }

            if (pageDirPath && zipFile) {
                await compressFolder(path.resolve(process.cwd(), 'dist/zip'), zipFile)
                console.log('打包文件夹完成，开始上传...')
            }

            //菜单翻译抽取(带缺失校验)与图标收集
            let menuI18n: Record<string, any> | undefined = undefined
            let menuIcons: Record<string, string> | undefined = undefined
            if (options.menus && options.menus.length > 0) {
                const i18nDirPath = path.resolve(process.cwd(), options.i18nDir || 'src/i18n')
                const iconDirPath = path.resolve(process.cwd(), options.iconDir || 'src/assets/svg')
                if (fs.existsSync(i18nDirPath)) {
                    menuI18n = extractMenuI18n(options.menus, i18nDirPath)
                    console.log(`🌐 菜单翻译抽取完成: ${Object.keys(menuI18n).join(', ')}`)
                } else {
                    console.warn(`⚠️ 语言包目录不存在,跳过菜单翻译上报: ${i18nDirPath}`)
                }
                if (fs.existsSync(iconDirPath)) {
                    menuIcons = collectMenuIcons(options.menus, iconDirPath)
                    if (Object.keys(menuIcons).length > 0) {
                        console.log(`🎨 菜单图标收集完成: ${Object.keys(menuIcons).join(', ')}`)
                    }
                }
            }
            for (let i = 0; i < distPaths.length; i++) {
                const distPath = distPaths[i]
                if (!fs.existsSync(distPath)) {
                    console.error(`❌ 文件不存在: ${distPath}`)
                    return
                }
            }
            try {
                const form = new FormData()
                form.append('appId', appId)
                form.append('appSecret', appSecret)
                form.append('project', options.project)
                form.append('remark', options.remark || '')
                form.append('version', version)
                if (options.pageDir) form.append('pageDir', options.pageDir || '')
                if (options.componentDir) form.append('componentDir', options.componentDir || '')
                if (options.pages) form.append('pages', JSON.stringify(options.pages || []))
                if (options.menus) form.append('menus', JSON.stringify(options.menus || []))
                if (menuI18n) form.append('i18n', JSON.stringify(menuI18n))
                if (menuIcons && Object.keys(menuIcons).length > 0) form.append('icons', JSON.stringify(menuIcons))
                if (options.micro) form.append('micro', JSON.stringify(options.micro))
                if (data) form.append('components', data)
                for (let i = 0; i < distPaths.length; i++) {
                    const distPath = distPaths[i]
                    if (!fs.existsSync(distPath)) {
                        console.error(`❌ 文件不存在: ${distPath}`)
                        return
                    }
                    form.append('files', fs.createReadStream(distPath))
                }
                if (zipFile) form.append('zip', fs.createReadStream(zipFile))
                const response: AxiosResponse<UploadResponse<any>> = await axios.post(server, form, {
                    headers: {
                        ...form.getHeaders(),
                    },
                    maxBodyLength: Infinity,
                })
                if (![201, 200].includes(response.status)) {
                    console.error(`❌ 服务器返回失败: ${response.data.message}`)
                }
                if (zipFile) fs.rmSync(zipFile, {recursive: true, force: true})
                if (zipDir) fs.rmSync(zipDir, {recursive: true, force: true})
                console.log(`✅ 已上传: ${response.data}`)
            } catch (err: any) {
                console.error(`❌ 上传失败: ${err}   msg:{${JSON.stringify(err?.response?.data)}`)
            }
        },
    }
}
