（本项目使用 GLM 5.3, DeepSeek-V4, MiniMax-M3 等模型构建）
# initnode —— 新云服务器初始化 CLI

一条命令完成新云服务器的接入:生成并部署 SSH 密钥、注册到 Komari 监控(自动发现)、可选安装厂商监控清理服务(agent-guard)、可选跑 NodeQuality 质量检测。

## 用法

```powershell
# 首次使用先装依赖,并注册全局命令 initnode(npm 全局 bin 已在 PATH)
npm install
npm link

# 之后任意目录直接运行
initnode
initnode -V        # 版本号
initnode -h        # 帮助
```

不注册也可以 `npm start` / `node index.js` 运行。

已发布到 npm(`@zuishuai-ziyi/initnode`),非开发机可以直接装:

```powershell
npm install -g @zuishuai-ziyi/initnode   # 或 npx @zuishuai-ziyi/initnode
initnode
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
| 5 | 将公钥写入 `authorized_keys`(幂等、自动去重、修正权限);**自动自检并启用服务器 sshd 公钥登录**;追加 `~/.ssh/config` 条目 + `ssh-keyscan` 写入 `known_hosts` |
| 6 | 用新私钥重新登录验证;若仍失败,用原认证方式重连 → 自动修复 sshd 配置 → 重试一次(此后可 `ssh <短别名>` 直连) |
| 7 | Komari 自动发现注册 → 服务器安装 komari-agent(带镜像回退)→ 写入节点名与标签 → 等待 agent 上线 → 可选安装 agent-guard 厂商监控清理服务 |
| 8 | 可选:NodeQuality 质量检测(实时回显,结束后给出报告链接) |

## 服务器禁用密钥登录时的自动启用

部分机器镜像默认 `PubkeyAuthentication no`,导致公钥写进去了却无法用密钥登录(步骤 6 报「认证失败」)。脚本对此做了自动处理,分两道闸:

1. **步骤 5 主动自检**(不阻塞):只读诊断 `sshd -T` 的生效值 → 需要时修复 → reload → 复验。
2. **步骤 6 失败兜底**:用首次连接的认证方式(密码/已有私钥)重连 → 诊断+修复 → 重写 `authorized_keys` → 重试一次。

修复动作(受控,可回滚):

| 项 | 做法 |
|----|------|
| 公钥登录 | 写 drop-in `/etc/ssh/sshd_config.d/00-initnode-pubkey.conf`:`PubkeyAuthentication yes` |
| Include 缺失 | 在 `sshd_config` 头部加 `Include /etc/ssh/sshd_config.d/*.conf`(sshd 关键字首次出现生效) |
| root 被禁 | 仅当 `PermitRootLogin no` 时补 `PermitRootLogin prohibit-password`(仍禁密码) |
| AuthorizedKeysFile | 若配置了非默认路径(如 `/etc/ssh/keys/%u`),把公钥同时写到那些路径(`%h`/`%u` 展开) |
| 权限/SELinux | `HOME` 去 group/other 写权限、`.ssh` 700、`authorized_keys` 600、`restorecon` |
| 安全网 | 先备份 `sshd_config.bak`;`sshd -t` 校验失败立即回滚并删除 drop-in;成功后 `systemctl reload sshd`(失败再试 `ssh`,最后 `restart`) |

不做的:不改 `PasswordAuthentication`、不动允许用户/组白名单(在白名单外的用户只提示不强行放宽)。无 root 或免密 sudo 时只报告 `no-privilege`,不影响后续流程。

## 厂商监控清理服务(agent-guard,可选)

初始化第 7 步末尾询问是否安装(默认是)。用于自动检测并清除云厂商 guest/管理/监控代理,覆盖 14 家:KVM(`qemu-guest-agent`)、VMware(`open-vm-tools`,含 vmtoolsd/vgauthd)、LXD(`lxd-agent`、lxd snap、`lxd-agent-loader`)、Azure(WALinuxAgent/waagent)、AWS(`amazon-ssm-agent`、`amazon-cloudwatch-agent`)、GCP(`google-guest-agent`、`google-osconfig-agent`)、阿里云(安骑士 aegis/AliYunDun、`aliyun-service` 云助手、cloudmonitor)、腾讯云(`barad_agent`、`tat_agent`、云镜 YDService/YDLive)、华为云(`hostguard`)、京东云(`jdog`)、Oracle(`oracle-cloud-agent`)、DigitalOcean(`do-agent`)、Xen(`xe-daemon`)、Hyper-V(`hv_kvp_daemon`/`hv_vss_daemon`);刻意不碰 komari-agent、cloud-init、宝塔、docker/containerd、nginx/php-fpm/mysqld、gost、sshd,也不碰第三方监控(netdata/zabbix/telegraf/node_exporter/datadog)。

安装内容(全部 systemd 原生机制,不依赖 cron):

| 组件 | 作用 |
|------|------|
| `/usr/local/bin/agent-guard.sh` | 清理脚本:purge 重新出现的代理包、按 comm 名与命令行双路杀进程(能识别 python/perl 型代理)、厂商 unit 一律 stop+disable+mask、清 SysV 自启链与 cron/rc.local 钩子、删残留目录、保持 lxd-agent 永久 mask;已 mask 的 unit 不重复动作 |
| `agent-guard.service` | 开机(oneshot)立即清一遍 |
| `agent-guard.timer` | 每分钟触发一次清理(兜底) |
| `agent-guard-monitor.py` + `.service` | netlink proc-connector 监听器:厂商代理进程被创建的同一秒即触发清理(26 个 comm 名 + 31 条 cmdline 片段,能识别 python 型代理) |

依赖处理:无 systemd 则放弃安装;缺 `flock`(util-linux)自动去掉并发锁行;缺 `python3` 时按 apt/dnf/yum/apk 顺序尝试安装,仍失败则跳过秒级监听(开机清理 + 每分钟 timer 不受影响)。

日志与卸载:动作日志 `/var/log/agent-guard.log`,心跳 `/run/agent-guard.lastrun`;卸载:`systemctl disable --now agent-guard.timer agent-guard.service agent-guard-monitor.service && rm -f /usr/local/bin/agent-guard.sh /usr/local/bin/agent-guard-monitor.py /etc/systemd/system/agent-guard*.service /etc/systemd/system/agent-guard.timer`。

## 一次性清理(agent-guard 之外)

`src/vendorclean/vendor-clean.sh` 是一次性「大扫除」,覆盖 KVM/VMware/LXD/Azure/AWS/GCP/阿里云(安骑士 aegis)/腾讯云(barad/TAT/云镜)/华为云/京东云/Oracle/DO/Xen/Hyper-V 等厂商代理:卸包(apt/dnf/yum/apk)、杀进程、stop+disable+mask unit、清 SysV 自启链与 cron/rc.local 钩子、删残留目录、清 snap lxd,最后复查并给出「命中/已处理/失败」统计。

- `sh vendor-clean.sh --dry-run` 只出清单不改系统;去掉 `--dry-run` 才真删(需 root,日志 `/var/log/vendor-clean.log`)
- `--third-party` 额外清 netdata / zabbix-agent / telegraf / node_exporter / datadog
- 刻意不动 cloud-init、komari-agent、宝塔、docker。详见 `src/vendorclean/README.md`

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

- `test/unit.mjs`:纯函数单元测试(命名、别名、config 解析、指纹、报告链接提取、agentguard 脚本、sshd 诊断/修复脚本构造与解析)
- `test/e2e.mjs`:内置 mock SSH 服务器(ssh2.Server)+ mock Komari 面板,管道喂入答案跑通全流程;含 4 个场景:①探测公网 IP+模板标签 ②关闭探测+自定义标签 ③NodeQuality 交互输入转发 ④**服务器禁用公钥登录→自动启用**(mock 在修复脚本执行前拒绝 publickey 认证)。不触真实 `~/.ssh` 与真实面板

测试重定向用的环境变量:`INITNODE_SSH_DIR`、`INITNODE_CONFIG`、`INITNODE_AGENT_INSTALL_URLS`(逗号分隔的安装脚本源列表)。

## 发布(npm)

包名 `@zuishuai-ziyi/initnode`,命令仍是 `initnode`(npm 上的 `initnode` 已被他人占用,v1.0.1,故用 scope)。本机 registry 是 npmmirror,发布路径由 `publishConfig.registry` 固定为 `registry.npmjs.org`,不受镜像配置影响。

**首次准备(一次性)**

1. npm 账号需拥有 `zuishuai-ziyi` 这个 scope(`npm login` 后 `npm whoami` 确认用户名一致)
2. npmjs.com → Access Tokens → Granular Access Token(Read and write,可选择该 scope 或所有包)
3. GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret,名字 `NPM_TOKEN`,值为上面的 token

**自动发布(CI)**

```powershell
npm version patch            # 或 minor / major:改 package.json + lock 并打 vX.Y.Z tag
git push origin main --follow-tags
```

推 `v*` tag 触发 `.github/workflows/publish.yml`:安装依赖 → `npm test` → 校验 tag 与 `package.json` 版本一致 → `npm pack --dry-run` 预览 → `npm publish --provenance --access public`。

**手动发布**

- Actions → `Publish npm` → Run workflow:默认 `dry-run=true`,只跑测试与打包校验;取消勾选才真正发布
- 本地校验:`npm run publish:dry`(只打包,不写 registry);确认无误后 `npm login && npm publish --access public`

**注意事项**

- `files` 只打包 `index.js` 与 `src/`,测试、`config.json`、`tmp/` 不会进包
- `prepublishOnly` 会先跑完整测试,失败则拒绝发布
- `--provenance` 需要仓库公开 + `permissions: id-token: write`(已在 workflow 配好),npm 包页面会显示「Built and signed on GitHub Actions」

## 注意事项

- 若服务器原本禁用公钥登录,脚本会修改 `/etc/ssh/sshd_config`(加 Include)并新增 drop-in `00-initnode-pubkey.conf`,然后 reload sshd;不想被改就先手动启用公钥登录,脚本检测到 `PubkeyAuthentication yes` 会跳过修改
- Windows 下依赖 `System32\OpenSSH\ssh-keygen.exe` / `ssh-keyscan.exe`(无则回退 PATH)
- NodeQuality 需要 5-15 分钟,Ctrl-C 会直接中断远端脚本
- 中途失败:已写入的 authorized_keys / ssh config / known_hosts / 已注册的 Komari 节点会保留,重跑时密钥会被询问「复用还是重新生成」,Komari 可能残留 `Auto-` 命名的节点需手动删除
