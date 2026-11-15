# v0.8.4

这次主要完善模型额度展示. 修复免 TUN 和汉化的启用流程. 并集中优化启动及切换会话时的卡顿.

## 模型额度

- 顶栏新增当前模型剩余额度圆环. 展开可查看各模型共享额度池和5 小时和每周窗口. 以及已知的重置时间.
- 支持手动刷新和自动更新和低额度提醒. 区分额度耗尽和无权限和未知和数据过期.
- 模型上下文设置列表同步显示小额度圆环和百分比. 方便查看各模型余量.
- 刷新按钮和额度进度条加入平滑动画. 减少闪烁及布局跳动.
- 有可靠校准依据时提供约剩余 Token 估算.

## 启动和会话切换更流畅

- 历史统计和账本处理移到后台. 减少全量扫描对界面的阻塞.
- 优化大账本去重及模型列表计算. 修复首次进入未访问会话时卡住两三秒的问题.
- 减少重复刷新和界面扫描. 快速切换会话时及时清除旧数据显示. 避免串到上一个会话.
- 优化应用提示词和上下文设置时的大文件处理. 操作期间界面保持响应.

## 免 TUN 与汉化

- 修复开启免 TUN 或汉化时反复提示退出重装的问题. 组件缺失时提供明确的补装步骤.
- 修复旧代理配置覆盖新设置和代理环境变量残留及部分窗口未应用代理的问题.
- 代理开关和地址和绕过列表保存后. 冷启动能正确恢复. 运行状态提示与实际加载一致.
- 已在 Windows 桌面客户端验证关闭 TUN和保持系统代理开启时正常发送请求并收到回复.
- 修复汉化开关和语言设置不同步和关闭汉化后状态误报的问题.
- 开启或关闭客户端汉化后准确提示重启. 重启后恢复对应语言.
- 品牌显示和插件面板语言和客户端语言各自独立. 动态提示跟随面板所选语言.

## 用量与其他修复

- 更新模型计价和额度匹配. 改善多来源记录去重和请求结束后的同步及账本读取失败保护.
- 修复弹窗对齐和展开抖动和底部裁切和滚动回弹. 改善深浅主题背景显示.
- 优化繁体中文面板用词.
- 改善 Windows 下 CLI 路径与包装脚本检测. 以及部分终端环境的启动兼容性.
- GitHub API 限流时. 更新检查和下载可回退到 GitHub 官方网页通道. 保留下载校验.
- Windows 辅助工具增加源码编译与哈希核对流程. 补充构建来源说明.
- 适配部分 Mac 路径与附件公式解析. 对不支持的配置操作给出准确提示.

## 感谢社区贡献

- [Azreal2021](https://github.com/Azreal2021) 的 [PR 7](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/7) 和 [PR 8](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/8). 额度圆环与 Windows CLI 启动修复.
- [MoiraToki](https://github.com/MoiraToki) 的 [PR 9](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/9). 模型计价与用量账本修复.
- [yinshengphy](https://github.com/yinshengphy) 的 [PR 11](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/11). 沙箱环境的汉化开关修复.
- [Andrew-liu](https://github.com/Andrew-liu) 的 [PR 12](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/12). 主题背景和汉化保护与额度面板方案.
- [nocoo](https://github.com/nocoo) 的 [PR 13](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/13). 弹窗对齐与抖动修复.
- [nokiy](https://github.com/nokiy) 的 [PR 14](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/14). 本次采用部分跨平台适配和主题及 Excel 共享公式解析修复.
- [U1tr0n-Lee](https://github.com/U1tr0n-Lee) 的 [PR 21](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/21). 繁体中文译文优化.

感谢 lvmin和iiyo 和 littlegrey 提供免 TUN 与汉化问题反馈. 感谢 [zhao33079-zhao](https://github.com/zhao33079-zhao) 提供 [Issue 22](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/22) 的更新限流排查和修复方案. 感谢 [riandycandra](https://github.com/riandycandra) 在 [Issue 17](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/17) 中提供检测结果及构建来源建议. 感谢 [git-aa12138](https://github.com/git-aa12138) 在 [Issue 23](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/23) 中反馈 Mac 配置问题.

## 验证结果

已在 Windows 桌面客户端 v2.32.1 完成本轮实机验收. Node 测试 313 项和 Python 测试 9 项全部通过.

Mac 端如果仍遇到问题欢迎反馈. 后续版本会继续修复.

