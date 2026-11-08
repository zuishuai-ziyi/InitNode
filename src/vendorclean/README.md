# vendor-clean —— 一次性云厂商代理「大扫除」

与 `../agentguard/`（常驻守卫，只盯 qemu-ga / vmtoolsd+vgauthd / lxd-agent）互补：
本目录是**一次性**清理脚本，适合拿到二手/回收机器、或不想装常驻守卫时手动跑一遍。

## 用法

```bash
# 干跑：只打印会执行的动作，不改系统（不需要 root）
sudo sh vendor-clean.sh --dry-run

# 真删（需要 root）：动作写 /var/log/vendor-clean.log，末次结果写 /run/vendor-clean.lastrun
sudo sh vendor-clean.sh

# 连第三方监控（netdata / zabbix-agent / telegraf / node_exporter / datadog）一起清
sudo sh vendor-clean.sh --third-party
```

退出码：`0` 已清理干净（或本来就没有）、`1` 有清理失败项、`2` 参数或权限错误。

## 覆盖范围

| 厂商 | 清理对象 |
|------|----------|
| KVM | `qemu-guest-agent`（qemu-ga） |
| VMware | `open-vm-tools`（vmtoolsd / vgauthd / vmware-tools 目录） |
| LXD/Incus | `lxd-agent`、`lxd-agent-loader`、snap `lxd`，并永久 mask `lxd-agent.service` |
| Azure | `walinuxagent`（waagent）、`azure-vm-utils` |
| AWS | `amazon-ssm-agent`、`amazon-cloudwatch-agent` |
| GCP | `google-guest-agent`、`google-osconfig-agent`、`google-compute-engine` |
| 阿里云 | aegis 安骑士（AliYunDun/AliYunDunUpdate/agentwatch）、`aliyun-service` 云助手、`aliyun-assist`、cloudmonitor |
| 腾讯云 | `barad_agent`、`tat_agent`（TAT 自动化助手）、云镜 YunJing（YDService/YDLive）、stargate |
| 华为云 | `hostguard`（HSS 主机安全） |
| 京东云 | `jdog` / `jdcloud-agent` |
| Oracle | `oracle-cloud-agent`（含 updater / uniagent） |
| DigitalOcean | `do-agent` |
| Xen | `xe-daemon`（xe-guest-utilities） |
| Hyper-V | `hv_kvp_daemon` / `hv-vss-daemon` |

## 刻意不动

`cloud-init`、`komari-agent`（本家监控）、宝塔 `BT-Panel`/`BT-Task`、docker/containerd、
nginx/php-fpm/mysqld、gost、sshd。第三方监控默认也不动，需要显式 `--third-party`。

## 执行顺序（幂等，可反复跑）

1. **厂商自带卸载器优先**：`/usr/local/aegis/uninstall.sh`、`/usr/local/cloudmonitor/uninstall.sh`、
   `/usr/local/qcloud/*/uninstall.sh`、`/usr/local/hostguard/uninstall.sh`、`/usr/local/uniagent/uninstall.sh`
   （存在才跑，`timeout 180`，失败不阻塞后续）
2. **卸包**：apt（`dpkg-query` 判存在 → `apt-get purge -y`，debconf 非交互）／dnf-yum／rpm -e／apk del
3. **杀进程**：`pgrep -f` 按完整命令行匹配（`[[:space:]]` 锚定 argv 边界），先 TERM 再 KILL，跳过自身与父进程
4. **systemd**：命中即 `stop` + `disable` + `mask`
5. **SysV 残留**：`/etc/rc?.d` 自启链、`/etc/init.d` 脚本（按厂商 token 匹配）
6. **残留目录**：`/usr/local/{aegis,cloudmonitor,qcloud,sa,uniagent,hostguard,jdcloud}`、`/var/lib/{waagent,google,amazon/ssm,oracle-cloud-agent}`、`/etc/{qemu,vmware-tools}`、`/var/snap/lxd` 等；`safe_rm_dir` 有保护路径黑名单
7. **snap lxd**：`snap remove lxd --purge` + `snap forget`
8. **cron/rc.local**：只删含厂商 token 的行，跳过 `agent-guard*` / `komari*` / `bt_*` / `BTPanel`
9. 永久 mask `lxd-agent.service`，`systemctl daemon-reload`
10. **复查**：重新扫包 / 进程，输出「命中 / 已处理 / 失败」和残留清单

## 已知取舍

- 只做一次性清理，不做常驻防复活；要防厂商代理被重装请装 `agent-guard`（见 `../agentguard/`）。
- `lxd-installer.socket`（Ubuntu 镜像的按需安装包装器）不在清理范围，它只在有人显式请求时才装 lxd snap。
- `--dry-run` 不写 `/var/log/vendor-clean.log`，也不写 `/run/vendor-clean.lastrun`。
