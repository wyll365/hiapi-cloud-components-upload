import type { Plugin } from 'vite'
import fs from 'fs'
import path from 'path'
import axios, {type AxiosResponse} from 'axios'
import FormData from 'form-data'

export interface UploadPluginOptions {
    server: string; // 服务器上传地址，例如 https://api.example.com/upload
    appId?: string; // 可选鉴权 token
    appSecret?: string; // 可选鉴权 token
    file: string; // 默认 dist/index.umd.js
    disable?: boolean; //是否禁用上传
    version?: string; //插件版本
}
interface UploadResponse<T> {
    code :number
    message : string
    data : T
}


export function UploadPlugin(options: UploadPluginOptions): Plugin {
    const {server, appId, appSecret, file,version='0.0.0',disable=false } = options

    return {
        name: 'vite-upload-plugin',
        apply: 'build',
        async closeBundle() {

            if (disable===true){
                return //上传插件被禁用,
            }

            console.log(`\n📦  开始上传编译文件到服务器: ${server}`)

            const distPath = path.resolve(process.cwd(), file)

            if (!fs.existsSync(distPath)) {
                console.error(`❌ 文件不存在: ${distPath}`)
                return
            }
            try {
                const form = new FormData()
                form.append('appId', appId)
                form.append('appSecret', appSecret)
                form.append('version', version)
                form.append('file', fs.createReadStream(distPath))

                const response: AxiosResponse<UploadResponse<any>> = await axios.post(server, form, {
                    headers: {
                        ...form.getHeaders(),
                    },
                    maxBodyLength: Infinity,
                })
                if (response.data.code !== 200) {
                    console.error(`❌ 服务器返回失败: ${response.data.message}`)
                }
                console.log(`✅ 已上传: ${path.relative(distPath, file)}`)
            } catch (err: any) {
                console.error(`❌ 上传失败: ${file}`)
                console.error(err.message)
            }
        },
    }
}
