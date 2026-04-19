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
    menus?: Menu[]
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
                console.error(`❌ 上传失败: ${err}`)
            }
        },
    }
}
