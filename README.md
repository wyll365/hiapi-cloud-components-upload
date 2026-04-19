# HIAPI-Cloud 项目 vite插件

仅用于 HIAPI-Cloud uniapp前端项目

此Vite插件 适用于 HiAPI-Cloud 子应用前端开发


````  javascript
          UploadPlugin({ // 上传发布版本到到云平台
                server: 'https://appstore.cloud.adinz.com/api/v1/releases/frontend', // 上传服务器地址
                project: 'hiapi-cloud-public', // 项目标识
                appId: 'P-10000', // 应用标识
                appSecret: 'b7f375749e48599156d03e49a798a3f4', // 应用密钥 ,妥善保管防止恶意上报造成损失
                file: `dist/build/h5/${pkg.name}.umd.js`, //静态前端文件
                files:[ `dist/build/h5/${pkg.name}.umd.js`], //编译后的文件, 支持多个文件上传
                version: pkg.version, // 版本号
                disable: false, // 是否禁用上传
                pageDir: 'pages', // 页面目录
                componentDir: 'hiapi-public', // 组件目录
                remark:'组件库发布', // 备注
                pages:[ //对外公布页面列表
                    { name:'首页', path:'pages/index/index' },
                ],
                menus:[] //后台 菜单
            })
````

```bash
npm config set registry https://registry.npmjs.org/
```

登陆: 
```shell
npm login
```
发布: 
```shell
npm publish --access public
```

npm config set registry https://registry.npmmirror.com/
