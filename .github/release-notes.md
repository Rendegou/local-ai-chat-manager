<!-- 这段说明会被 .github/workflows/release.yml 挂到每个 Release 上。 -->

### 下载哪个

| 平台 | 文件 |
| --- | --- |
| Windows | `.msi`（推荐）或 `-setup.exe` |
| macOS | `.dmg`，universal 包，Intel 与 Apple Silicon 通用 |

### macOS 首次打开会被系统拦下（正常现象）

安装包只做了 ad-hoc 签名，没有 Apple 开发者证书、也没有公证，所以第一次打开时 macOS 会拦：

- 提示「无法验证开发者」：右键点 app → **打开** → 再点一次 **打开**，只需做一次；
  或者到 **系统设置 → 隐私与安全性**，点「仍要打开」。
- 如果提示「**已损坏，无法打开**」：这是 macOS 给下载文件加的隔离标记导致的，不是文件真坏了。
  在终端执行一次即可（路径按实际安装位置改）：

  ```bash
  xattr -cr "/Applications/Local AI Chat Manager.app"
  ```

### Windows

安装时可能出现 SmartScreen 提示：点「更多信息」→「仍要运行」。

### 说明

完整的功能与限制说明见仓库 README。会话数据全部留在本机，同步只通过你自己的 Git 仓库进行。
