# initnode —— 新云服务器初始化 CLI

一条命令完成新云服务器的接入:生成并部署 SSH 密钥、注册到 Komari 监控(自动发现)、可选跑 NodeQuality 质量检测。

## 用法

```powershell
# 首次使用先装依赖
npm install

# 运行
npm start          # 或 node index.js
```

按提示依次输入:

1. **Komari 面板地址**(默认本家实例)与**管理员 API Key**(WebUI → 个人设置/安全 中创建,格式 `komari-xxxx`;首次输入后存入项目根 `config.json`,已被 .gitignore 排除)
2. **服务器连接信息**:地址(IPv4/IPv6/域名)、SSH 端口、用户名、首连认证(密码或已有私钥)、是否自动探测公网 IP
3. **信任主机指纹**(TOFU):展示 SHA256 指纹供人工核对
4. **节点名称**(用于密钥注释与 Komari 节点名)、**标签**(可选,多选)

## 标签与公网 IP

- **标签**:Komari 的 tags 为分号分隔字符串(`香港;测试`)。常用模板自动从已注册节点推导(节点名按「厂商 - 地区 - IP尾段」拆段 + 已设 tags),输入编号可多选,也可直接输入自定义文本
- **公网 IP 自动探测**:连接后可在服务器上执行多端点探测(curl/wget,IPv4/IPv6,api.ip.sb / ipify / ifconfig.me / ip.3322.net)。探测结果三种用法:
  1. 仅密钥命名/别名用公网 IP,连接地址保持不变(连接地址为内网/回环时的默认项)
  2. 连接地址(HostName)也替换为公网 IP(直连公网地址时的默认项)
  3. 忽略探测结果

## 初始化流程

| 步骤 | 动作 |
|------|------|
| 1 | 验证 Komari admin key,自动读取自动发现密钥,拉取已注册节点推导标签模板 |
| 2 | 询问服务器连接信息(地址/端口/用户/首连认证)与是否探测公网 IP |
| 3 | 首连(TOFU);可选探测服务器公网 IP 并选择用途 |
| 4 | 询问节点名称与标签,生成 ed25519 密钥对(复用系统 `ssh-keygen.exe`) |
| 5 | 将公钥写入 `authorized_keys`(幂等、自动去重、修正权限);追加 `~/.ssh/config` 条目 + `ssh-keyscan` 写入 `known_hosts` |
| 6 | 用新私钥重新登录验证(此后可 `ssh <短别名>` 直连) |
| 7 | Komari 自动发现注册 → 服务器安装 komari-agent(带镜像回退)→ 写入节点名与标签 → 等待 agent 上线 |
| 8 | 可选:NodeQuality 质量检测(实时回显,结束后给出报告链接) |

## 本地产物(与既有惯例一致)

- 密钥:`~/.ssh/<host 冒号转下划线>_id_ed25519[.pub]`,注释 = 节点名称
  (如 `77.93.157.132_id_ed25519`、`2404_8c80_85_8001__51_id_ed25519`)
- ssh config 条目:

  ```
  # initnode: <节点名称>
  Host <短别名> <host>
    HostName [IPv6 加方括号]
    Port <port>
    User <user>
    IdentityFile "C:\Users\<你>\.ssh\<...>_id_ed25519"
  ```

- 短别名惯例:IPv4 取首段(`77.93.157.132` → `77`)、IPv6 取首组(`2404:...::51` → `2404`);冲突时会要求另指定

## 测试

```powershell
npm test
```

- `test/unit.mjs`:纯函数单元测试(命名、别名、config 解析、指纹、报告链接提取)
- `test/e2e.mjs`:内置 mock SSH 服务器(ssh2.Server)+ mock Komari 面板,管道喂入答案跑通全流程(NodeQuality 选择跳过);不触真实 `~/.ssh` 与真实面板

测试重定向用的环境变量:`INITNODE_SSH_DIR`、`INITNODE_CONFIG`、`INITNODE_AGENT_INSTALL_URLS`(逗号分隔的安装脚本源列表)。

## 注意事项

- Windows 下依赖 `System32\OpenSSH\ssh-keygen.exe` / `ssh-keyscan.exe`(无则回退 PATH)
- NodeQuality 需要 5-15 分钟,Ctrl-C 会直接中断远端脚本
- 中途失败:已写入的 authorized_keys / ssh config / known_hosts / 已注册的 Komari 节点会保留,重跑时密钥会被询问「复用还是重新生成」,Komari 可能残留 `Auto-` 命名的节点需手动删除
