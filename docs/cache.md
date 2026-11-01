# 历史数据缓存（MySQL + Redis，可选）

不配置也能正常用。配置之后，这些「历史」数据会存进 MySQL，重启或再次点开同一个币时只补上次之后的新数据：

| 数据 | 以前 | 有缓存后 |
| --- | --- | --- |
| Four 盘全部成交（实时成交翻页、交易者盈亏） | 每次从创建区块起分段查链上日志 | 只查上次查到的区块之后 |
| Flap 门槛盘内盘成交 | 每次启动从创建起扫 Portal 事件 | 只扫上次之后 |
| Gang 盘全部成交 / K 线 | gang.fun 接口每页 200 条从头翻（2 万笔约 100 页） | 翻到接上库里最新一笔为止（通常 1 页） |
| Gang V3 曲线盘 / stocks pad 盘链上成交（K 线、成交、成交量） | 每次重启从开盘前的区块重扫 pad 的 Buy / Sell 日志 | 记住查到的区块，只补之后的 |
| 外盘链上成交（PancakeSwap V2 池子的 Swap） | 重启后只剩最近约 4500 块（约半小时） | 存下来；重启后从上次读到的区块接着读（`RPC_ARCHIVE=1` 时断开 1 天内都能接上） |
| 外盘分钟 K 线 | 只有 GeckoTerminal 最近 1000 根，重启就没了 | 存下来，最多显示 4000 根 |
| BNB 小时价（持仓美元成本） | 每次启动重拉 | 存过的不再请求 |
| 钱包交易记录（我的持仓成本） | 每分钟调 5 次 baw tx-history | 翻到接上已存的为止（通常 1 次） |

Redis 存 DexScreener / GeckoTerminal 的接口结果 15 秒，几个钱包后端同时看同一个币时只请求一次。

MySQL 或 Redis 连不上、报错、超时都不影响使用：自动走原来的路径，30 秒后再试连。`/api/cache-status` 可以看连上没有。

## 启动

一条命令（需要已装好并打开 Docker Desktop 或 OrbStack）：

```bash
scripts/enable-cache.sh
```

它会装依赖、随机生成数据库密码、起 MySQL + Redis（端口只开在本机）、把 `MYSQL_URL` / `REDIS_URL` 写进 `.env`，可以重复运行。然后重启 TMTN 就生效。

想自己动手的话：

```bash
npm install                          # mysql2 / ioredis 是可选依赖，会一起装上
TMTN_DB_PASSWORD=换一个密码 docker compose -f docker/cache-compose.yml up -d
```

`.env` 里加：

```
MYSQL_URL=mysql://tmtn:<同一个密码>@127.0.0.1:13306/tmtn
REDIS_URL=redis://127.0.0.1:16379
```

关掉：把 `.env` 里这两行清空再重启。表在第一次连上时自动建。额外钱包的容器（docs/add-wallet.md）要用同一个库时，容器里的地址写 `host.docker.internal:13306` / `host.docker.internal:16379`，或者把这两个服务放进同一个 compose 用服务名访问。
