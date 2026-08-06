// @ts-ignore
import type {Plugin} from 'vite'
import fs from 'fs'
import path from 'path'
import axios, {type AxiosResponse} from 'axios'
import FormData from 'form-data'
import archiver from 'archiver'
import vm from 'vm'
import esbuild from 'esbuild'

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
    /**
     * @deprecated 页面链接改为**运行期实时获取** —— 子应用实现框架的 `AppLinkProvider` SPI
     * (`links()` / `options()`)，装修器打开链接选择器时由 hiapi-cloud-public 实时调用。
     *
     * 静态清单的问题：发版之后就不会再变，而且表达不了带参数的页面（商品详情、设备详情
     * 这类必须先选出具体是哪一个）。
     *
     * public 侧的入库路径（AppStoreLogic.reloadPages）已删除，继续传这个字段不再有任何效果。
     * 保留字段只是为了不让各子应用的构建立刻报错 —— 迁到 SPI 之后请删掉。
     */
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


/** stub 命名空间:解析不了 / 不该真解析的模块都落到这里 */
const STUB_NAMESPACE = 'hiapi-upload-stub'

/**
 * 从组件注册表里提取 widgetExport。
 *
 * 做法是用 esbuild 把 `src/components/index.ts` 打成一份 CJS,再在 vm 沙箱里执行取值。
 *
 * 为什么不再是「正则删掉 import + 直接跑」(2026-08-05 之前的做法):
 * 那套靠一串定制正则把 TS 洗成 JS,只在注册表恰好是「一个大对象字面量」时才成立。
 * 它带着两条隐含约束,而且踩中时的报错都指不到点子上:
 *
 *   1. **注册表里不能调用任何 import 进来的函数** —— import 全被替换成 `const X = null`,
 *      于是 `image: thumbnailOf('x')` 变成 `null('x')`,报 "thumbnailOf is not a function"。
 *      光看这句话没人会想到「你的注册表是被沙箱执行的」。
 *   2. **被牵连进来的本地模块不能带类型注解** —— 像 `const svg = (body: string): string =>`
 *      这种,vm 直接 SyntaxError。正则清洗覆盖不了任意 TS 语法。
 *
 * esbuild 处理 TS 是它的本职,两条约束一起消失:注册表可以正常 import 本地工具函数。
 *
 * `.vue` 与包依赖仍然解析成空模块 —— SFC 在 node 里跑不起来,而注册表只是把组件
 * 当值放着(`component: HiapiPublicSwiper`)从不调用它,值是不是真组件不影响提取。
 *
 * @param entryFile   组件注册表入口(src/components/index.ts)
 * @param projectRoot 消费方工程根目录,用来解析 `@/` 别名
 */
async function extractWidgetExport(entryFile: string, projectRoot: string) {
    // 必须用异步 build:esbuild 的 buildSync 不支持 plugins
    // ("Cannot use plugins in synchronous API calls"),而 stub 解析全靠 plugin。
    const result = await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        format: 'cjs',
        // 刻意**不用** platform:'node':那样 __toESM 会走 nodeMode,无条件把整个模块
        // 塞进 default(`isNodeMode || !mod.__esModule` 短路),下面 stub 的 __esModule
        // 标记就白设了,`Component` 会从 null 变成 {}。这里不解析任何真实包
        // (非相对路径全被 stub 拦掉),所以平台差异没有别的影响。
        platform: 'browser',
        logLevel: 'silent',
        plugins: [{
            name: STUB_NAMESPACE,
            setup(build) {
                build.onResolve({filter: /.*/}, args => {
                    if (args.kind === 'entry-point') return null
                    const spec = args.path
                    // `@/` 是 uni-app / vite 工程的惯例别名,指向 src。
                    // 手动补扩展名而不用 esbuild 的 alias 选项:onResolve 返回 path 之后
                    // esbuild 不再走扩展名解析,直接给绝对路径会找不到 .ts 文件。
                    if (spec.startsWith('@/')) {
                        const base = path.resolve(projectRoot, 'src', spec.slice(2))
                        const candidates = [base, `${base}.ts`, `${base}.js`,
                            path.join(base, 'index.ts'), path.join(base, 'index.js')]
                        for (const c of candidates) {
                            if (fs.existsSync(c) && fs.statSync(c).isFile()) return {path: c}
                        }
                        // 解析不到就当空模块,不要让整个构建挂在一个取不到的缩略图上
                        return {path: spec, namespace: STUB_NAMESPACE}
                    }
                    if (spec.endsWith('.vue') || !spec.startsWith('.')) {
                        return {path: spec, namespace: STUB_NAMESPACE}
                    }
                    return null
                })
                build.onLoad({filter: /.*/, namespace: STUB_NAMESPACE}, () => ({
                    // 取任何成员都得到 null,与旧实现的 `const X = null` 行为一致 ——
                    // 上报给市场的注册表里 `Component` / `Property` 必须还是 null。
                    //
                    // `__esModule: true` 这一手是必须的:否则 esbuild 的 __toESM 会把
                    // 整个 stub 对象当成 default 导出,`Component` 就从 null 变成 {},
                    // 悄悄改掉上报数据的格式(不报错、只在下游表里体现)。
                    // Proxy 的 target 必须**真的带上** __esModule / default 两个 own key:
                    // __toESM 走的是 __copyProps(ownKeys),空 target 复制不出任何东西,
                    // `.default` 就成了 undefined —— 而 undefined 会被 JSON.stringify
                    // 连键一起丢掉,上报出去的注册表里 Component 字段直接消失。
                    contents: 'module.exports = new Proxy({__esModule: true, default: null}, '
                        + '{get: (t, k) => k in t ? t[k] : null})',
                    loader: 'js',
                }))
            },
        }],
    })

    const code = result.outputFiles[0].text
    const moduleObj: { exports: Record<string, any> } = {exports: {}}
    const sandbox = {
        module: moduleObj,
        exports: moduleObj.exports,
        require: () => null,
        console,
    }
    vm.runInNewContext(code, sandbox)

    // 两种写法都要认:具名 `export const widgetExport` 和 `export default widgetExport`。
    // 旧实现是往洗过的源码尾巴上追加 `module.exports = { widgetExport }`,直接引用了
    // 模块里的局部变量,所以它对导出形式根本不敏感 —— 换成真打包之后就敏感了,
    // 而现有工程(hiapi-cloud-public-web)用的恰好是 export default。
    const exported = moduleObj.exports
    return exported['widgetExport'] ?? exported['default'];
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
            let data: string | undefined = undefined;
            if (componentDirPath) {
                // 直接从源码提取,不再往 zip 里拷一份 index.ts 就地改写再删掉 ——
                // esbuild 在内存里打包,中间产物落不到磁盘上
                const widgetExport = await extractWidgetExport(
                    path.resolve(process.cwd(), `src/components/index.ts`),
                    process.cwd(),
                )
                if (!widgetExport || Object.values(widgetExport).length === 0) {
                    throw new Error('组件模板数据为空')
                }
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
