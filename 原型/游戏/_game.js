// ★★ Round 24：innerHTML「内容没变就不重建」（_DSH_HTML_DEDUP）
//
//   为什么要：
//     render() 每 200ms 跑一次，重建 30 个容器的 innerHTML
//     ⇒ ① <select> 下拉框【刚点开就被重建】⇒ 根本点不中
//        ② 每 5 秒重建整界面 ⇒ 性能浪费
//
//   ⚠️ 写法上的坑（我第一版就踩了，导致栈溢出）：
//     ① set 里【不能】用 `this.textContent = ''` —— 那会打乱节点，
//        且不能用 innerHTML 解析（会递归回本 setter）
//     ② 必须用 `insertAdjacentHTML`（它走原生解析，不经过本访问器）
//     ③ 清空用 `replaceChildren()`（它只动子节点，干净）
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype._dshDedup) {
  HTMLElement.prototype._dshDedup = true;
  Object.defineProperty(HTMLElement.prototype, 'innerHTML', {
    configurable: true,
    get: function () { return this._dshHTML == null ? '' : this._dshHTML; },
    set: function (v) {
      var s = String(v);
      // ⚠️⚠️ 致命陷阱：`el.innerHTML = ''` 是"清空"的常用写法，
      //   而很多地方是【先清空、再 appendChild 逐个加】的模式
      //   （例如分区网格 grid.innerHTML='' 后 appendChild 每个格子）
      //   ⇒ 若把空串也去重，第二次就不再清空 ⇒ 【格子累积、界面畸形】
      //   ⇒ 所以：空串【永远执行】，只有非空内容才去重
      if (s !== '' && this._dshHTML === s) return;

      // ★★ 关键：用户正在操作这个容器时，【不能重建】
      //
      //   为什么：<select> 一旦被重建，已经展开的下拉就会被浏览器收起
      //     ⇒ 表现"刚点开就被刷新掉、根本选不了"
      //   ⇒ 检测：容器内部（含自身）是否有焦点元素
      //     · 下拉框获得焦点 ⇒ 整个容器跳过本帧重建
      //     · 用户选完、焦点移开 ⇒ 下一帧正常重建
      try {
        if (typeof document !== 'undefined' && document.activeElement &&
            this.contains && this.contains(document.activeElement)) {
          return;                            // ★ 本帧不重建（保住展开的下拉）
        }
      } catch (e) { /* 忽略 */ }

      this._dshHTML = s;
      // 用 insertAdjacentHTML 解析（不经过本 setter ⇒ 无递归）
      try {
        this.replaceChildren();
        if (s) this.insertAdjacentHTML('afterbegin', s);
      } catch (e) {
        this._dshHTML = null;
        throw e;
      }
    }
  });

  // ★★ 关键配套：任何【后置 DOM 变更】都必须让去重失效
  //
  //   为什么：去重的前提是「DOM == _dshHTML」。
  //   如果内部又 appendChild / insertAdjacentHTML / replaceChildren 过，
  //   这个等式就不成立了 ⇒ 下次写同样的 HTML 会跳过清空 ⇒ 【内容无限累积】。
  //   实测受害：gb（功法容器）—— 它是 `innerHTML = html` 之后又 `appendChild(pbox)`
  //   表现：用户看到「优先 1.凝神归元 ▲▼」重复 8 组
  //
  //   ⇒ 覆盖这几个方法：执行前先把 _dshHTML 置空，让下次赋值必定重建
  (function () {
    var invalidate = function () { this._dshHTML = null; };
    ['appendChild', 'append', 'prepend', 'insertBefore',
      'insertAdjacentHTML', 'insertAdjacentElement',
      'replaceChildren', 'removeChild', 'remove'].forEach(function (m) {
        var orig = HTMLElement.prototype[m];
        if (typeof orig !== 'function') return;
        HTMLElement.prototype[m] = function () {
          this._dshHTML = null;               // ★ 去重失效
          return orig.apply(this, arguments);
        };
      });
  })();
}

// ============================================================
// 秘境录 · 可玩原型 v1
//
// 目标：验证"摸鱼手感" —— 挂在屏幕上，有事挂机刷宝，
//       没事看装备、调 BD。
//
// 数值来源：与 原型/_params.js 完全一致（层 2 配表成果）
//   · 六分区容量随境界扩张
//   · 11 部位 × 5 品质 × 形状库
//   · 错位转换 + 次位衰减
//   · B / margin 标定、危险模型、精英降级
// ============================================================

'use strict';

// ---------------- 一、参数（与 _params.js 同步） ----------------
const P = {
  ATK_BASE: 100, DEF_ANCHOR: 200, HP_BASE: 1500,
  DMG_VARIANCE: 0.10,
  DEF_SOFT_THRESHOLD: 400, DEF_SOFT_RATE: 0.5,
  // ★ 每档乘区：从 ×1.20 降到 ×1.0946（档数 10→24，总跨度仍保持 ×8）
  //   ⇒ 每大境界 ×1.198（原设计 5 境界时是 ×1.44）
  R_ATK: 1.0946, R_HP: 1.0946, R_DEF: 1.0946,
  // ★ 修为（境界与难度合并后的单轴）
  // ★ 修为档数 = 炼气 1 档 + 其余 11 境界 × 2 档 + 羽化飞仙 1 档 = 24
  TIERS: 24,
  REALM_PER_TIER: 2,      // 每 2 档 = 一个大境界
  // 灵气标定：一局（780 杀）约产出 810 灵气
  //   目标：每档约 1.6 局 ⇒ 完整修为约 14 局 ≈ 35 分钟真实时间
  ITEM_VAL_RATE: 1.038,  // ★ 装备数值每 ilvl 增长率（Round 23：1.03 → 1.038）
  //   ★ 为什么：ilvl = 1+档×6 ⇒ 1.03^6 = ×1.194/档，而小怪 hp 是 ×1.25/档
  //     差 5% 会让"几刀击杀"从 2 漂到 7 ⇒ 越到高档越砍不动
  //     1.038^6 = ×1.250/档 ⇒ 与 mobHp 完全同步
  ITEM_VAL_BASE: 20,   // ★ 装备数值基数（Round 23：10 → 20）
  //   ★ 为什么：原基数 10 时"满装几刀击杀"从 2 漂到 7（越到高档越砍不动）
  //     提到 20 ⇒ 2/2/2/2/3/3/3/3（几乎完全持平）✅
  //   与 ITEM_VAL_RATE 配合：rate 负责【增长率同步】，base 负责【绝对强度】   // ★ 装备数值基数（Round 23 战力缩放：待定，试调中）
  QI_BASE: 150,           // 第 1 档突破所需灵气（Round 29 再校：260 → 150）
  QI_GROWTH: 1.0,         // （保留字段，改用下面的曲线）
  // 灵气曲线：需求随档位【超线性】增长，但不像指数那样陡
  //   qiNeed(t) = QI_BASE × (t+1)^QI_EXP
  //   早期每档 1~2 局，后期每档 15~20 局
  QI_EXP: 2.6,            // 曲线指数（Round 29 再校：1.85 → 2.6）
  //   ★ 为什么改（用户实测反馈："我怎么第7代都活到地仙了 运气太好了？我才中等宗门啊"）
  //     ① 旧参数 320×n^1.2 太浅 ⇒ 理论上一生能到【金仙(档23)】= 进度终点
  //        ⇒ 境界失去意义，"人人是金仙"
  //     ② 用户实测第 7 代就【地仙(档18)】，而设计意图是"地仙以上必须跨代"
  //     ③ 新参数 260×n^1.85 ⇒
  //          基础一生 ≈ 合体期(档13)
  //          满配一生 ≈ 渡劫期(档16)
  //          【地仙以上】必须靠【宗门底盘 + 多代积累】
  //   ⚠️ 这是第 6 次改这个参数。前 5 次都因为【测错基准】：
  //      ① 以为一局 5 分钟/一生 36 局（实际 2 分钟/88 局）
  //      ② 给了一身传奇装测灵气（虚高 2 倍）
  //      ③ 手写 step 循环而不用 tick()（漏掉 endRun）
  //      ④ 用"保守装"估灵气（低估）
  //      ⑤ 这次是【用户实测数据】驱动的修正 —— 最可靠的一次
  //   ★ 最终定案依据（用游戏自己的 tick() 全真模拟，0 异常）：
  //     修正 DIFF_MOBHP_RATE(1.25→1.13) 与 ITEM_VAL_BASE/RATE 后，
  //     基础弟子一生 86 局实测累计 ≈ 19,400 灵气
  //     指数 1.2 ⇒ 基础一生【化神期(档9)】占 83% ✅
  //                满配一生【合体期(档12)】✅
  //     合体以上（大乘/渡劫/地仙/天仙/金仙）留给【跨代底盘】
  //
  //   ⚠️ 这个参数我改了 5 次（1.9→1.5→2.0→1.6→1.2），每次都是因为【测错了基准】：
  //     ① 以为一局 5 分钟、一生 36 局（实际 2 分钟 / 88 局）
  //     ② 给了一身传奇装测灵气（虚高 2 倍）
  //     ③ 手写 step 循环而不用 tick()（漏掉 endRun ⇒ 档位不推进）
  //   ⇒ 教训：配平前必须先确认【基准 == 玩家真实情形】。
  //   ★ 为什么是 2.0：
  //     ① 上轮(1.5)是基于【错误局数】—— 我以为一局 5 分钟、一生 36 局，
  //        实际一局 2 分钟(2.5×速)、一生 88 局 ⇒ 误差 2.4 倍
  //     ② 也低估了灵气产出：实测一局 620 → 2291（平均 1303），不是 700
  //     ③ 全真模拟：88 局累计 106,660 灵气 ⇒ 指数 1.5 时到【大乘期】(过远)
  //     ④ 指数 2.0 ⇒ 基础一生【炼虚期(档10)】· 满配一生【合体期(档13)】✅
  //     ⑤ 合体以上（大乘/渡劫/地仙/天仙/金仙）留给【跨代底盘】
  //   ★ 为什么改：原 1.9 时一生 36 局只能到元婴期，24 档内容有 3/4 永远看不到
  //     改 1.5 后一生恰好走完【化神期】，配合"宗门底盘"可达更高
  //     见 层2数值.md §58
  // ★ 标定：一个弟子（寿元 3 小时 ≈ 72 局）能爬到【化神期】（第 8 档）
  //   全程 24 档需约 1208 局 ⇒ 需 12~17 代弟子才能飞仙
  //   按一天 3 代 ⇒ 约 5~6 天摸到羽化飞仙

  // ---- 弟子寿命与传承（赛马娘式多世代结构）----
  LIFESPAN_HOURS: 3,      // 一个弟子的寿元（现实时间）
  // ★ 寿元的"修仙口吻"换算：3 小时现实时间 = 一生 = 100 年
  //   用户要求：HUD 显示【年数】，悬停才显示具体现实时间
  LIFESPAN_YEARS: 100,
  LEGACY_SLOTS: 3,        // 传承槽位（能带几件给下一代）
  // ★ 离线结算
  OFFLINE_CAP_HOURS: 8,        // 离线收益封顶（一个工作日）
  OFFLINE_RATE_FALLBACK: 2.5,  // 没有历史击杀速率时的保守值（只/秒）
  OFFLINE_MATERIAL_PER_DROP: 1,// 离线每件掉落折算成多少素材（不逐件生成）
  // ★ 离线效率——这里有一个【容易搞错 150 倍】的陷阱：
  //
  //   游戏内击杀速率是"只/【游戏秒】"（一局 780 只 / 300 游戏秒 = 2.6/秒），
  //   而原型以约 150 倍速跑（一局真实只花约 2 秒）。
  //   若直接拿它乘【真实离线秒数】⇒ 超发 150 倍
  //   （实测：离开 3 小时斩妖 27000 只 = 32 局的价值，直接冲 6 个档）
  //
  //   标定目标：离线 3 小时 ≈ 3 局（≈ 20 分钟主动游玩的价值）
  //   ⇒ 保留"主动玩更赚"，同时让挂机有实在收益
  // ⚠️ 这个常量有【两套口径】，别混用（R67 差点因此静默改掉传承收益）：
  //   ① 传承/交接里的"寿元兑现灵气"（legacyQiValue / 灵气封存）：
  //      rate = atk × KILL_RATE_PER_ATK（只/【游戏秒】）× 寿元（【游戏秒】）
  //      ⇒ 单位自洽，用的就是下面这个 0.12
  //   ② 离开结算 settleAway：时长是【真实秒】⇒ 必须用 AWAY_EFFICIENCY（见下）
  OFFLINE_EFFICIENCY: 0.12,
  // ★ R67：离开结算（settleAway）专用的效率 —— 真实秒口径。
  //   为什么是 0.048 而不是 0.12：settleAway 里 rate 已换算成【只/真实秒】
  //   （= 只/游戏秒 × CLOCK_RATIO）⇒ 0.048 × 2.5 = 0.12，
  //   与原实现的实际产出【完全一致】。改成 0.12 会让离线收益凭空 ×2.5。
  AWAY_EFFICIENCY: 0.048,
  // ★ R67：后台（切标签页）结算 —— 与离线【分开】
  //   设计：把"在线"与"离开"正式分成两件事
  //     · 在线 = 看打（不追求挂机效率，反正你看得见）
  //     · 离开（切后台 / 关页面）= 按真实时间结算
  //   为什么这么分：浏览器对【不可见标签页】的定时器有节流（后台 ≥1 次/秒、长时间后台更狠），
  //   而 tick() 每次固定推进 0.5 游戏秒 ⇒ 后台期间游戏其实在"龟速跑"，而旧代码对这种
  //   短时离开【完全不补】（applyOffline 门槛 120 秒）⇒ 收益白丢。
  //   效率定 0.5 的理由：要低于在线（否则"看着打"就没价值了），但不能像离线那样只有几个百分点
  //   （上班摸鱼必然要切走，惩罚太重等于逼玩家不切）。⇒ "看着"值 2 倍于"切走"。
  BG_EFFICIENCY: 0.5,
  BG_MIN_SECONDS: 5,           // 低于这个时长不结算（避免频繁切窗口把收益刷成"结算制"）
  BG_CAP_SECONDS: 3600,        // 单次后台结算封顶 1 小时（再长按"离线"那套算）
  KILL_RATE_PER_ATK: 0.0085,
  // ★ 五行相性（层 1 §5.2 定稿值）
  WX_KE: 1.30,                 // 克制
  WX_BEATEN: 0.75,             // 被克制
  // ★ 功法改造后的参数（Round 12 · 设计规格_功法改造方案.md）
  GF_FASHI_PER_KILL: 0.009,    // 焚心诀：每击杀攻击 +0.9%（叠 12 层）
  GF_FASHI_HOLD_SEC: 6,        // 焚心诀：停手 6 秒后层数减半
  GF_QINGXIN_EVADE: 0.18,      // 清心咒：低血时闪避 +18%
  GF_ZHUIFENG_PER_STACK: 0.04, // 追风步：每层出手 +4%（6 层）
  GF_TUNA_IDLE: 3,             // 吐纳术：停手 3 秒触发
  GF_TUNA_MUL: 1.6,            // 吐纳术：蓄势一击伤害倍率
  GF_TUNA_AOE: 2,              // 吐纳术：额外多打 2 个目标
  GF_LINGBO_WINDOW: 3,         // 凌波微步：闪避后 3 次出手提速
  GF_LINGBO_FREQ: 0.35,        // 凌波微步：提速幅度
  GF_POJUN_ATK: 0.25,          // 破军式：被围时伤害 +25%
  GF_POJUN_TAKEN: 0.10,        // 破军式：被围时承压伤害 +10%
  GF_JINGANG_THRESH: 4,        // 金刚体：受击后阈值 +4
  GF_JINGANG_SEC: 2,           // 金刚体：持续 2 秒
  GF_GUIXI_CUT: 0.30,          // 龟息功：承压伤害 −30%
  GF_GUIXI_FREQ: 0.15,         // 龟息功：出手频率 −15%（真实代价）
  GF_LIANQI_PER: 20,           // 炼气化神：每 20 杀
  GF_LIANQI_QI: 60,            // 炼气化神：+60 灵气
  // ★ 冷却缩减（CDR）：只作用于 cd='sec' 的【保命类】主动技能
  //   不作用于 cd='swing'（否则出手频率会同时放大 DPS 与技能频率，正反馈过强）
  CDR_CAP: 0.40,               // CDR 上限（层2 §36.6）
  // ★ 4 条新增主动技能（设计规格_功法主动技能方案.md §6）
  GF_NINGSHEN_HEAL: 0.40,      // 凝神归元：立即回复 40% 生命
  GF_NINGSHEN_CUT: 0.25,       // 凝神归元：减伤 25%
  GF_NINGSHEN_SEC: 4,          // 凝神归元：持续 4 秒
  GF_SUODI_AOE: 2,             // 缩地成寸：额外多打 2 个目标
  GF_SUODI_CRIT: 1.0,          // 缩地成寸：必暴（暴击加成 +100%）
  GF_SUODI_WINDOW: 3,          // 缩地成寸：持续 3 次出手
  GF_WANJIAN_SEC: 30,          // 万剑归宗：每 30 游戏秒
  GF_WANJIAN_MUL: 6.0,         // 万剑归宗：全场 ×6（清场越快 ⇒ 被围越少）
  GF_WANJIAN_WINDOW: 45,       // 万剑归宗：首次释放的时间门槛
  GF_JINZHONG_SHIELD: 0.28,    // 金钟罩：护盾 = 28% 最大生命
  GF_JINZHONG_SEC: 4,          // 金钟罩：护盾可存续 4 秒
  // ★ 法宝的五行相性：作用于"催动这一击"（一次性战术事件）
  //   数值比普通相性温和，因为它是叠加在"催动倍率"之上的
  FB_WX_BONUS: 1.25,           // 法宝五行克制目标
  FB_WX_PENALTY: 0.80,         // 法宝五行被目标克制
  // 怪物五行的分布口径：每档"主导属性"的占比。越高档越分散 ⇒ 专精 build 越难受
  WX_DOMINANT: [1.00, 0.70, 0.55, 0.45, 0.38, 0.33, 0.29, 0.26, 0.24, 0.22, 0.21, 0.20],
  // 采集口径正确（12 个境界 → 12 个不同主导属性）
  // ★ 传承给赠（Round 12）
  LEGACY_QUIET_REALM2: 0.01,   // 余韵倍率 = 1 + 大境界序号² × 这个值
  LEGACY_PHASE2_EFFECT: 0.4,   // 阶段二：效果大打折扣到 40%
  LEGACY_PHASE2_TIME: 0.3,     // 阶段二：时长再延 30%
  LEGACY_MAX_STACK: 3,         // 层数软上限（同类最多叠 3 层）
  LEGACY_MAX_EFFECT_STACK: 2,
  GIFT_DAO_RATE: 0.15,         // 传道：每层灵气获取 +15%
  GIFT_GUARD_RATE: 0.10,       // 护道：每层突破需求 -10%（原"必定成功"无对象）
  GIFT_FORESEE_RATE: 0.25,     // 推演：每层击杀灵气 +25%
  GIFT_SECT_RATE: 0.20,        // 镇派：每层"指定分区基础值 +20%"         // 传道：每层灵气获取 +15%  // 效果软上限（最多 2 层生效，第 3 层只加时长）   // 每点基准攻击 ≈ 每秒能杀多少只（= 2.6/300 的近似，见层2）
  HANDOVER_QI_HINT: true,
  SEARCH_RUNS: 4,         // 搜寻遗落传承需要几局
  LOST_DEPTH: 12,         // 遗落深度（以修为档计：约"化神期"）。修为达到即全取回
  QI_PER_KILL: 1,         // 击杀小怪获得灵气
  QI_PER_ELITE: 6,        // 击杀精英获得灵气
  // ★ 修仙境界阶梯（12 大境界，终点为"羽化飞仙"）
  REALMS: ['炼气期', '筑基期', '金丹期', '元婴期', '化神期', '炼虚期',
           '合体期', '大乘期', '渡劫期', '地仙', '天仙', '金仙'],
  REALM_DESC: ['引气入体，凡人起步', '筑就道基，脱去凡骨', '结成金丹，寿元大增',
               '元婴出窍，化身千万', '神识化虚，感悟天地', '炼化虚空，登堂入室',
               '法体合一，大能之境', '大道将成，半步登仙', '历经雷劫，逆天而行',
               '陆地神仙，超脱凡俗', '飞升天界，逍遥自在', '金性不朽，与天同寿'],
  // 羽化飞仙 = 金仙之后追加的一档（封顶）
  ASCEND_NAME: '羽化飞仙',
  ASCEND_DESC: '破空而去，与道合真',

  SPAWN_START: 1.0, SPAWN_PEAK: 5.0, RAMP_TIME: 120, RUN_SECONDS: 300,
  // ★ 刷怪速率【随修为成长】（Round 12 配平修正 · 用户决策 A）
  //   问题：刷怪固定 3/s，玩家清场却随装备涨到 ~17/s
  //         ⇒ 场上只有 0.2 只怪 ⇒ 承压圈里没怪 ⇒ 从不掉血
  //   修法：刷怪随修为成长（1.09^tier，与玩家攻击的 1.0946 同步）
  //         ⇒ 【清场/刷怪 的比值在所有档恒定】（实测 ×5~6 全档持平）
  //   用户原话："更强的割草能力就是要更多的草来割才有爽感"
  // ★ 怪的数值【按修为定档】（Round 12 · 用户原则）
  //
  //   原则（用户原话）："玩家的数值和怪的数值都随着修为来定，
  //   每个修为有个大概的范围，而不是怪直接随着玩家涨。
  //   如果玩家的实力比现在这个修为强，就应该有正反馈，
  //   而且也能让玩家更快突破到下个境界。"
  //
  //   ⇒ 每档的怪数值 = 该档【典型玩家】的水平，与玩家实际构筑无关
  //   ⇒ 玩家比该档典型更强 ⇒ 清场更快 ⇒ 灵气/掉落更多 ⇒ 更快突破（正反馈）
  //   ⇒ 玩家比该档典型更弱 ⇒ 被围 ⇒ 危险
  //
  //   实测"该档典型玩家"（该档自然掉落装备全套）：
  //     有效生命/阈值 都以 ≈×1.28/档 成长 ⇒ 怪的每只伤害必须同速成长
  //     清场速率 ≈15~17/s 全档持平
  MOB_DMG_TIER_RATE: 1.28,   // 每只怪伤害 ×1.28/档（与玩家有效生命同步）
  MOB_DMG_BASE: 123,         // 档 1 的每只怪伤害
  SPAWN_TIER_RATE: 1.098,   // 峰值 档1=5/s ⇒ 档24≈5×1.098^23≈42/s ⇒ 圈内/阈值 ≈0.9（有压力不死）
  SPAWN_BURST: 2.0,        // 起步 = 峰值/2（ramp 期间场上约为峰值的一半）
  MOB_HP_BASE: 107, ACT_FREQ_BASE: 3.0, ACT_FREQ_REALM: 1.20,
  AOE_BASE: 3,
  // ★★ R61：出手节拍拉长倍数（用户："杀怪显示的慢一些，近战至少得看出来砍死怪物"）
  //
  //   问题（实测）：出手 4.60 次/秒 ⇒ 间隔 **217ms**，而"看清一次打击过程"需要 ≥250ms；
  //   再叠 AOE 6 个目标同帧结算 ⇒ 过程被压成 1 帧，玩家只看到怪"凭空少了几只"。
  //
  //   做法：出手间隔 ×CADENCE，**每刀伤害同时 ×CADENCE** ⇒
  //     · 单位时间输出（DPS）**完全不变** · 一局击杀总数与收益**不变** · 配平不用重做
  //     · 变的是"节拍"：原来 217ms 一刀，现在 434ms 一刀、但那一刀重一倍
  //
  //   ⚠️ 连带影响（按【出手次数】计的机制）必须等比换算，否则语义会漂：
  //     · 功法主动技 `cd:'swing'`（10/10/12/15/20）· 法宝「木灵回春」每 25 次出手
  //       ⇒ 统一改用【加权出手数】`GF.swingW`（每次出手 +CADENCE），阈值一个字都不用改
  //     · 功法「凌波微步」闪避后 N 次出手提速 ⇒ 同样按加权单位递减
  //
  //   ★ R63：2 → 3。为什么还要再拉一档（用户："又短又快，平a有点看不清"）：
  //     注意【游戏时钟是真实时间的 2.33×】—— CADENCE=2 时出手间隔 429 游戏秒
  //     只有 **真实 184ms**（5.5 刀/秒），弧光会一直叠着 ⇒ 平A 看不清。
  //     =3 ⇒ 645 游戏秒 = **真实 277ms**，每刀是一个可分辨的节拍。
  //     每刀伤害同时 ×3（在 baseDmg 处）⇒ **DPS 与一局收益不变**（有探针复核）。
  CADENCE: 3,
  THRESHOLD_R: 10, SURVIVE_SECONDS: 25, OVERLOAD_ASSUMED: 10,

  // ★ 距离 / 威胁圈（用户提案 + 二次修正）
  //
  // 修正历程：
  //   ① 原设计危险是【全场计数】⇒ 漏洞："场上 20 只怪全在屏幕外你也掉血"
  //   ② 改为【威胁圈内计数】，圈是固定值 0.16
  //   ③ 现在：攻击范围由【武器】决定（不同武器差别很大），
  //      威胁圈也不再是固定值，而是【随修为收缩】(修为高 ⇒ 紧张感小)
  //
  // 不变量：威胁圈半径永远 ≤ 最短武器中位距离
  //   ⇒ 否则短兵器会被"圈外怪白打"，玩家无解
  THREAT_BASE: 0.235,   // ★ 0.165→0.235：圈内怪数翻倍，让承压真的会发生     // 炼气期威胁圈半径
  THREAT_PER_REALM: 0.94, // 每境界 ×0.94（修为越高，感受威胁的范围越小）
  THREAT_MIN: 0.150,      // 下限（否则高修为怪永远进不来，变得无威胁）

  // 难度会把圈放大（怪多、压迫强）
  THREAT_PER_TIER: 1.035,

  MOB_REACH: 0.055,       // 怪的近战距离（很小：它们要贴上来才施压）
  // ★★ R210：怪"出手"的节拍 —— 把连续承压伤害离散成"可见的一次扑击"
  //   为什么需要（用户："表现得和怪更有来有回一点"）：
  //     旧实现是【连续 DPS 按帧摊】，怪只有"存在/消失"两态、没有任何出手动作
  //     ⇒ 整个战斗是单向的，只有弟子在打，玩家看到的是"血条缓缓下降"。
  //   做法：把 dps × dt 累积起来，每 MOB_ATK_CD 游戏秒结算一次，并由
  //     【威胁圈内最近的几只怪】各出一份（最多 MOB_ATK_MOBS 只）。
  //   ⚠️ 伤害积分【严格不变】（同一积分的离散化）⇒ 配平零风险，有探针复核。
  //   1.0 游戏秒 = 真实 400ms —— 真实 ≥250ms 才看得清一次动作，且不至于太稀。
  MOB_ATK_CD: 1.0,
  MOB_ATK_MOBS: 3,        // 一拍最多几只怪一起扑（再多就糊了，且总伤害仍精确分摊）
  MOB_LUNGE_MS: 380,      // 扑击动作时长（真实毫秒）
  HIT: { MISS_BASE: 0.08, HIT_BASE: 0.90, EVADE_BASE: 0.05, CRIT_BASE: 0.05, CRIT_DMG_BASE: 0.50 },
  // ★ 闪避：软上限（和防御完全同一套逻辑）
  //   基础闪避 5.8% 只是"标定基准"，玩家堆的是【原始闪避 rawEvade】
  //
  //   设计依据（用户提案）：
  //     · 一直堆有收益，但永远不到顶
  //     · 常规能堆到约 50%
  //     · 收益越来越低
  //   ⇒ 阈值 35% 内全额，超出部分按 50% 计（与防御的 DEF_SOFT 同构）
  EVADE_REF: 0.03,        // ★ 标定基准闪避 = 裸装时的有效闪避（= WANDER_EVADE，必须一致）
  EVADE_SOFT: 0.30,       // 软上限阈值（以内全额）
  EVADE_SLOPE: 1.2,       // 超出后的斜率（越大越快逼近上限）
  WANDER_EVADE: 0.03,     // 纯走位带来的闪避（"运气好躲开了"）
  // ★ EVADE_REF 必须 = 裸装时的有效闪避（走位 WANDER_EVADE + 基准 BASE）
  //   否则"基准闪避下 25 秒"这个标定就不再成立
  EVADE_BASE: 0.00,       // 额外基准（留 0，让 EVADE_REF 与裸装严格相等）
  DASH_DIST: 0.075,       // 闪避突进距离（归一化）
  DASH_SPEED: 0.30,       // 突进速度（远高于游走，才有"突然位移"感）
  DASH_TIME: 0.28,        // 突进持续时间（秒）
  AVOID_STRENGTH: 0.085,  // 避怪偏移的最大距离（权重 1.0 时）
  GEAR_EVADE_MAX: 1.00,   // 原始闪避的硬性封顶（避免数值失控；实际由公式渐近）
  // ★ 走位：角色会随机游走，走位本身提供基础闪避（用户提案）
  WANDER_RADIUS: 0.115,   // 游走半径（归一化）—— 太小会看不出来走动
  WANDER_SPEED: 0.020,    // 游走速度
  WANDER_EVADE: 0.03,     // 纯走位带来的闪避（"运气好躲开了"）
  QUALITY_STAT_MUL: [1.00, 1.10, 1.22, 1.35, 1.50],
  ELITE: { HP_MUL: 3, DMG_MUL: 2.0 },
  ELITE_DOWNGRADE_HITS: 4.0,
  DIFF_MOBHP_RATE: 1.13,  // ★ 小怪血量每档增长率（Round 23：1.25 → 1.13）
  //   ★ 为什么改：
  //     小怪 hp ×1.25/档，而玩家裸手只有 ×1.0946/档
  //     装备已提到 ×1.25/档（ITEM_VAL_RATE），但仍追不上差距
  //     ⇒ 实测弟子卡在【金丹期】出不去（88 局累计 12,122 灵气）
  //   1.13 与"玩家裸手 1.0946 + 装备补足"大致同步，
  //   让"几刀击杀"不再随档位恶化。
  HARMONY: [0.94, 1.03, 1.06, 1.10, 1.15, 1.22],
  HARMONY_TH: [0, 2, 5, 8, 10, 13],
  ORIGIN_PER_KILL: 1, ORIGIN_COST: 60,
};

const QUALITIES = ['普通', '精良', '史诗', '传奇', '神话'];
const QCOLOR = ['#8b93a3', '#5aae6a', '#4a9fd8', '#c07adf', '#e0a83a'];

// 分区容量（炼气 → 化神）
// ★ 分区容量曲线：原设计 5 境界（22→34），现扩到 12 境界（22→51）
//   起点与原设计一致，终点按同比例延长（避免"高阶装不上装备"）
const ZONE_CAP = {
  '躯干':  [ 8,  9, 10, 10, 11, 12, 12, 13, 13, 14, 14, 15],
  '双手':  [ 5,  5,  6,  6,  6,  7,  7,  7,  8,  8,  8,  9],
  '背':  [ 1,  2,  2,  3,  3,  4,  4,  5,  5,  6,  6,  7],
  '手臂':  [ 3,  3,  4,  4,  5,  5,  6,  6,  7,  7,  8,  8],
  '双腿':  [ 3,  3,  4,  4,  5,  5,  6,  6,  7,  7,  8,  8],
  '头':  [ 2,  2,  2,  2,  3,  3,  3,  3,  4,  4,  4,  4],
};
const ZONE_RECT = { '双手': [2, 3], '躯干': [2, 6], '背': [2, 2], '手臂': [2, 2], '双腿': [2, 2], '头': [2, 1] };
const ZONE_MOD = {
  '双手': { stat: '攻击力', add: 0.25 }, '躯干': { stat: '防御', add: 0.25 },
  '手臂': { stat: '出手频率', add: 0.20 }, '头': { stat: '命中与暴击', add: 0.20 },
  '双腿': { stat: '承压阈值', add: 0.20 }, '背': { stat: '清场速度', add: 0.15 },
};
const SLOT_ZONE = {
  '主手': '双手', '副手': '双手', '头': '头', '项链': '头',
  '肩': '躯干', '胸': '躯干', '腰': '躯干', '手': '手臂', '戒指': '手臂',
  '腿': '双腿', '足': '双腿',
};
// 形状库（_shapes.js 校验过的方案）
const SHAPES = {
  '主手': [[1,1],[1,2],[1,3],[1,3],[2,2]], '副手': [[1,1],[1,1],[1,2],[1,2],[1,3]],
  '头': [[1,1],[1,1],[2,1],[2,1],[2,1]],   '肩': [[1,1],[1,2],[1,2],[1,3],[1,3]],
  '胸': [[1,2],[1,3],[2,2],[1,5],[2,3]],   '手': [[1,1],[1,1],[1,1],[1,2],[1,2]],
  '腰': [[1,1],[1,2],[1,2],[1,3],[1,3]],   '腿': [[1,1],[1,2],[1,2],[2,2],[2,2]],
  '足': [[1,1],[1,1],[1,2],[1,2],[1,2]],   '项链': [[1,1],[1,1],[1,1],[1,1],[1,1]],
  '戒指': [[1,1],[1,1],[1,1],[1,1],[1,1]],
};
const SLOT_MAIN = { '主手':'攻击', '副手':'攻击', '头':'防御', '肩':'防御', '胸':'防御',
  '腰':'防御', '手':'速度', '腿':'防御', '足':'速度', '项链':'生命', '戒指':'生命' };
// ★ 部位 → 装备器型（文案里不能拿槽位名当装备名："足"槽里的东西是"靴"，不是"足"）
const SLOT_NOUN = {
  '主手':'武器', '副手':'武器', '头':'冠', '项链':'项链', '肩':'肩甲',
  '胸':'战甲', '腰':'腰带', '手':'护手', '戒指':'戒指', '腿':'护腿', '足':'靴',
};
// ★ 部位 → 量词（"一双靴 / 一枚戒 / 一把剑"；武器再按实际类型细分）
const SLOT_MEASURE = {
  '头':'顶', '项链':'串', '肩':'副', '胸':'件', '腰':'条',
  '手':'副', '戒指':'枚', '腿':'副', '足':'双',
};
const WEAPON_MEASURE = { sword:'把', blade:'把', spear:'杆', bow:'张', staff:'根' };
function itemMeasure(slot, weaponId) {
  if (slot === '主手' || slot === '副手') return '一' + (WEAPON_MEASURE[weaponId] || '把');
  return '一' + (SLOT_MEASURE[slot] || '件');
}

// ★ 武器类型（用户提案：不同武器的【攻击范围】与【AOE 数量】互为取舍）
//
// 设计意图：
//   剑  —— 范围极短，但横扫一片（AOE 最高）
//   枪  —— 范围长，打击面小但单发最疼（一寸长一寸强）
//   弓  —— 范围最长，落点溅射
//   杖  —— 范围中等，打击面广但单发弱
//
// ★ 配平约束（实测得出）：清场能力 = 出手频率 × AOE × 系数 ÷ B 必须 > 刷怪峰值(3.0)
//   AOE=1 在当前刷怪速率下【不可用】（一秒只能杀 1.5 个，必被围死）
//   ⇒ 最低 AOE 取 2。范围与 AOE 反向，伤害系数与 AOE 反向 ⇒ 三者构成真实取舍
// ★ Round 16：武器类型【只决定手感】（reach / aoe / dmgMul），不再决定五行。
//   武器五行与其它装备一样由 rollWuxing() 随机 ⇒ 任何武器都能匹配任意同调。
const WEAPONS = [
  { id:'sword', name:'剑', reach:0.090, aoe:6, dmgMul:0.85, desc:'范围极短 · 横扫一片' },
  { id:'blade', name:'刀', reach:0.120, aoe:4, dmgMul:1.10, desc:'范围中等 · 兼顾' },
  { id:'spear', name:'枪', reach:0.185, aoe:3, dmgMul:1.45, desc:'一寸长一寸强 · 单发最疼' },
  { id:'bow',   name:'弓', reach:0.230, aoe:3, dmgMul:1.30, desc:'范围最长 · 落点溅射' },
  { id:'staff', name:'杖', reach:0.150, aoe:5, dmgMul:0.75, desc:'打击面广 · 单发偏弱' },
];
// ---------------- 五行相性（层 1 §5.1–§5.2 · 六乘区之一）----------------
//
// 相克环（单向）：金克木 → 木克土 → 土克水 → 水克火 → 火克金 → 回金
// 相生环（单向）：金生水 → 水生木 → 木生火 → 火生土 → 土生金 → 回金
//
// 倍率（层 1 §5.2，已是定稿值）：
//   克制 ×1.30 · 被克制 ×0.75 · 无关 ×1.00
// ★ 双向生效：我打他和他打我各自独立判定
//
// ⚠️ 设计取舍：这会打破"生存窗口恒定 25 秒"（被克时只剩 19 秒）。
//    25 秒是【属性无关】时的基准；相性把它变成有方向的浮动区间。
//    这是刻意的——它让"属性身份"成为真实的 BD 维度。
const WUXING = ['金', '木', '水', '火', '土'];
const KE = { 金:'木', 木:'土', 土:'水', 水:'火', 火:'金' };   // A 克 KE[A]
const SHENG = { 金:'水', 水:'木', 木:'火', 火:'土', 土:'金' }; // A 生 SHENG[A]

// ============================================================
// ★ 五行正统关系（Round 17 · 单一事实源）
//
//   用户要求："五行相生相克具体是怎么样的，你按照正统的说法来重新改一下"
//
//   正统（《尚书·洪范》/ 中医五行 / 阴阳家）：
//     相生（母子）：木生火 · 火生土 · 土生金 · 金生水 · 水生木
//     相克（所胜）：木克土 · 土克水 · 水克火 · 火克金 · 金克木
//     —— 生克皆为【环】，无始无终。
//
//   ⚠️ 关键推论（必须理解，否则会误判配平）：
//     五行之间【不存在"完全无关"的一对】——
//       任意两行，要么同源、要么一方生另一方、要么一方克另一方。
//       ⇒ 4 个对手 = 1 同源 + 1 相生 + 1 相克 + 1【反向相生或反向相克】
//     ⇒ 这正是"五行表是 5×5 完全图"的原因。
//
//   另一条方向约定（阴阳家的"生克方向"）：
//     相生方向 = 我生者（我泄）、生我者（我之母）
//     相克方向 = 我克者（我所胜）、克我者（我所不胜 / 官杀）
//     ⇒ 本作【不做】泄/侮的独立倍率（那是命理学的用法，游戏里会变成第二套生克），
//       只保留：克 ×1.30 / 被克 ×0.75 / 其余 ×1.00。
// ============================================================
const WX_ZHENG = {
  sheng: '金→水→木→火→土→金',   // 相生环（金的顺序仅为起点，环无始）
  ke: '金→木→土→水→火→金',      // 相克环
  note: '生克皆环；五行间不存在"完全无关"的一对',
};
// 自检：验证 SHENG / KE 与正统表格一致（不一致就返回问题列表）
function wxSelfCheck() {
  const S = { 金: '水', 水: '木', 木: '火', 火: '土', 土: '金' };
  const K = { 金: '木', 木: '土', 土: '水', 水: '火', 火: '金' };
  const bad = [];
  for (const a of WUXING) {
    if (SHENG[a] !== S[a]) bad.push('SHENG[' + a + ']=' + SHENG[a] + ' 应为 ' + S[a]);
    if (KE[a] !== K[a]) bad.push('KE[' + a + ']=' + KE[a] + ' 应为 ' + K[a]);
  }
  return bad;
}
// 关系查询（唯一入口，避免各处自己判生克）
function wxRelOf(a, b) {
  if (!a || !b) return 'none';
  if (a === b) return 'same';
  if (SHENG[a] === b) return 'iSheng';      // 我生对方
  if (SHENG[b] === a) return 'shengMe';     // 对方生我
  if (KE[a] === b) return 'iKe';            // 我克对方
  if (KE[b] === a) return 'keMe';           // 对方克我
  return 'none';                            // ★ 理论上不可达
}
const WX_REL = { same: '同源', iSheng: '我生', shengMe: '生我', iKe: '我克', keMe: '克我', none: '无关' };
const WX_COLOR = { 金:'#e8d9a0', 木:'#7fc47f', 水:'#7fa8e8', 火:'#e8836a', 土:'#c9a678' };

// 相性乘区：攻方属性 atkEl 打守方属性 defEl
function wxMul(atkEl, defEl) {
  if (!atkEl || !defEl) return 1;
  if (KE[atkEl] === defEl) return P.WX_KE;          // 攻方克制守方
  if (KE[defEl] === atkEl) return P.WX_BEATEN;      // 攻方被守方克制
  return 1;
}

// 武器的 AOE 还要乘品质与词缀加成（这里是基础值）
const WEAPON_BY_ID = {};
WEAPONS.forEach(w => WEAPON_BY_ID[w.id] = w);


const OFFZONE_KEEP = 0.65, CONVERT_DECAY = 0.60;

// ---------------- 掉落率表（C1）----------------
// 设计依据：装备与掉落.md §7.1 / §7.2
//   每局掉落多少件、品质怎么分布、分解产出多少
const DROP = {
  PER_KILL: 1 / 6,               // ★ Round 18：原 1/22。用户："出去历练可能会有很多装备，多出来的全部分解" ⇒ 提高掉落，素材才有来源
  ELITE_MULT: 8,             // 精英掉落概率 ×8（精英应该有明显的掉落回报）
  MIN_ON_WIN: 3,
  MIN_ON_DEATH: 1,
  DEATH_RATE: 0.5,           // 阵亡时掉落减半
  ILVL_PER_TIER: 6,          // 每档难度 +6 物品等级
  ILVL_WIN_BONUS: 3,         // 通关额外 +3
  // 品质权重（基础），受难度影响
  BIAS_MAX: 0.45,
  // 分解产出（素材）
  DISENCHANT: [1, 2, 5, 12, 30],
};
// 每件掉落的价值（用于"这件值不值得看"）
function itemScore(it) {
  return it.mainVal * (1 + it.q * 0.35);
}

const SPECIAL = {
  '主手': { '背': { keep:0.60, convert:'清场速度' }, '头': { keep:0.65, convert:'命中与暴击' } },
  '副手': { '背': { keep:0.60, convert:'清场速度' }, '头': { keep:0.65, convert:'命中与暴击' } },
  '胸':   { '手': { keep:0.65, convert:'攻击力' } },
};

// ---------------- 二、数学工具 ----------------
const effDef = d => d <= P.DEF_SOFT_THRESHOLD ? d
  : P.DEF_SOFT_THRESHOLD + (d - P.DEF_SOFT_THRESHOLD) * P.DEF_SOFT_RATE;
const dmgMul = d => P.DEF_ANCHOR / (P.DEF_ANCHOR + effDef(d));
// ★ 闪避的软上限：阈值内全额，超出部分【渐近趋于 1】但永远到不了
//
//   ⚠️ 第一版写成"超出部分线性折半"：
//      softEvade(5) = 0.35 + (5−0.35)×0.5 = 2.675  ⇒ 超过 100%，数学上不成立
//   第二版斜率太小（原始 100% 只到 68%），参数空间浪费。
//
//   最终式（t=30%, k=1.2）：
//      x ≤ t : x
//      x > t : t + (1−t) × (1 − 1/(1+y)) ,  y = (x−t) × k / (1−t)
//
//   实测效果：原始 35%→36% · 50%→48% · 65%→56% · 100%→68% · ∞→100%⁻
//   ⇒ 一直有收益、收益递减、永远不到顶（正是要的性质）
//
//   与防御的差异：防御是除法式（除以防御永远不为 0），闪避是乘法式（1−闪避），
//   所以闪避必须显式做成渐近 1，不能照抄防御的线性折半。
const softEvade = x => {
  if (x <= P.EVADE_SOFT) return x;
  const y = (x - P.EVADE_SOFT) * P.EVADE_SLOPE / (1 - P.EVADE_SOFT);
  return P.EVADE_SOFT + (1 - P.EVADE_SOFT) * (1 - 1 / (1 + y));
};
const R = (a, b) => a + Math.random() * (b - a);

function offzone(slot, zone) {
  const home = SLOT_ZONE[slot];
  if (home === zone) return { keep: 1, convert: null, cmul: 1, same: true };
  const sp = SPECIAL[slot] && SPECIAL[slot][zone];
  if (sp) return { keep: sp.keep, convert: sp.convert, cmul: CONVERT_DECAY, same: false };
  return { keep: OFFZONE_KEEP, convert: ZONE_MOD[zone].stat, cmul: CONVERT_DECAY, same: false };
}


// ---------------- 三之三、事件流与挂机报告 ----------------
//
// 用户提案（C）：挂机报告要像小说，只记重要事件，重复刷怪不记。
//
// 设计：所有事件进 EVENTS，带【重要性】权重；报告按阈值过滤后套模板。
//   重要性参考：普通掉落 1 · 史诗 4 · 传奇 6 · 神话 9 · 突破 5 · 身亡 7
const EVENTS = [];
// ★★ Round 35：事件自动带【成长快照】—— 编年史要能看出"越来越强"
//   用户诉求："宗门很久才变好，但当前弟子越来越强要看得见"
//   原来只记 type/imp/t/gen ⇒ 报告只能写"讣告"，写不出"变强过程"
//   ⇒ 现在每个事件都带：atk（攻击力）/ kills（累计击杀）/ qi（累计灵气）/ tier
function ev(type, imp, data) {
  let atk = 0, qi = 0;
  try { atk = playerStats().atk | 0; } catch (e) { /* 早期调用时可能还没准备好 */ }
  try { qi = G.qiTotal | 0; } catch (e) { }
  EVENTS.push({
    type, imp,
    t: Date.now(), gen: SECT.generation,
    atk: atk,
    kills: (G.totalKills | 0),
    qi: qi,
    tier: (G.tier | 0),
    ...data,
  });
  if (EVENTS.length > 400) EVENTS.splice(0, EVENTS.length - 400);
}

// ---------------- 编年史（Round 35 重写）----------------
//
// 用户诉求："宗门很久才变好，但当前弟子越来越强要看得见"
//
// ⚠️ 旧报告的问题：
//   它是【每代一行的讣告】，不是【成长曲线】。
//   一代 88 局压缩成一句话，玩家永远看不到变强的过程。
//
// ⇒ 新版：把报告从【结算卡】改成【编年史】，两个区：
//     上区 = 弟子生平（带时刻的事件流 + 强度跃升）
//     下区 = 宗门账（门规变动 / 编制 / 宗门阶 / 传承）
function idleReportData(sinceMs) {
  const since = sinceMs || G._seenAt || 0;
  const list = EVENTS.filter(function (e) { return e.t > since && e.imp >= 4; });
  const out = { disciple: [], sect: [] };
  if (!list.length) return out;

  // 按代分组（编年史以"代"为章）
  const byGen = {};
  for (const e of list) (byGen[e.gen] = byGen[e.gen] || []).push(e);
  const gens = Object.keys(byGen).map(Number).sort(function (a, b) { return a - b; });

  for (const g of gens) {
    const es = byGen[g].slice().sort(function (a, b) { return a.t - b.t; });
    const ch = { gen: g, name: "", lines: [], startAtk: 0, peakAtk: 0, runs: 0, cause: null, sect: [], tier: 0 };
    const seenBreak = {};
    for (const e of es) {
      const atk = e.atk | 0;
      if (atk > ch.peakAtk) ch.peakAtk = atk;
      if (!ch.startAtk && atk) ch.startAtk = atk;
      if (e.type === 'break') {
        if (seenBreak[e.realm]) continue;          // 同一境界只记一次
        seenBreak[e.realm] = 1;
        const gain = (e.atkAfter && ch.peakAtk) ? (e.atkAfter - ch.peakAtk) : 0;
        ch.lines.push({ t: e.t, k: 'break', e: e,
          txt: '破入【' + e.realm + '】' + (e.atkAfter ? ' · 攻击 ' + e.atkAfter : '') +
            (gain > 0 ? '（+' + gain + '）' : '') });
      }
      else if (e.type === 'drop_myth') ch.lines.push({ t: e.t, k: 'myth', e: e, txt: '得【神话·' + (e.nm || SLOT_NOUN[e.slot] || e.slot || '') + '】' });
      else if (e.type === 'drop_legend') ch.lines.push({ t: e.t, k: 'legend', e: e, txt: '获【传奇·' + (SLOT_NOUN[e.slot] || e.slot || '') + '】' });
      else if (e.type === 'elite_king') ch.lines.push({ t: e.t, k: 'kill', e: e, txt: '斩【' + (e.name || '精英') + '】' });
      else if (e.type === 'boss_kill') ch.lines.push({ t: e.t, k: 'kill', e: e, txt: '讨伐 Boss【' + (e.name || '') + '】' });
      else if (e.type === 'legacy_get') ch.lines.push({ t: e.t, k: 'legacy', e: e, txt: '取回先辈传承 ' + (e.n || 0) + ' 件' });
      else if (e.type === 'dujie_ok') ch.lines.push({ t: e.t, k: 'dujie', e: e, txt: '渡劫成功' + (e.realm ? ' → 【' + e.realm + '】' : '') });
      else if (e.type === 'dujie_fail') ch.lines.push({ t: e.t, k: 'bad', e: e, txt: '渡劫失败' + (e.realm ? '（冲【' + e.realm + '】未成）' : '（留道伤）') });
      else if (e.type === 'death_old') ch.cause = '善终';
      else if (e.type === 'death_handover') ch.cause = '主动交接';
      else if (e.type === 'death_battle') ch.cause = '战死秘境';
      else if (e.type === 'ascend') ch.lines.push({ t: e.t, k: 'ascend', e: e, txt: '★ 羽化飞仙' });
      // ---- 宗门账（下区）----
      else if (e.type === 'sect_rank') ch.sect.push({ t: e.t, k: 'rank', e: e, txt: '宗门晋为【' + (e.rank || '') + '】' });
      else if (e.type === 'rule_add') ch.sect.push({ t: e.t, k: 'rule', e: e, txt: '立门规〈' + (e.axis || '') + '·' + (e.value || '') + '〉' });
      else if (e.type === 'rule_neg') ch.sect.push({ t: e.t, k: 'neg', e: e, txt: '积弊成形〈避' + (e.zone || '') + '〉' });
      else if (e.type === 'recruit') ch.sect.push({ t: e.t, k: 'recruit', e: e, txt: '招徒 ' + (e.n || 0) + ' 人' });
    }
    const h = SECT.history.find(function (x) { return x.gen === g; });
    ch.runs = h ? h.runs : 0;
    if (h && h.name) ch.name = h.name;
    if (!ch.name && g === SECT.generation && DISCIPLE && DISCIPLE.name) ch.name = DISCIPLE.name;
    if (h && h.tier != null) ch.tier = h.tier | 0;
    else if (g === SECT.generation && DISCIPLE) ch.tier = DISCIPLE.peakTier | 0;
    ch.pers = (h && h.pers) || (g === SECT.generation && DISCIPLE ? DISCIPLE.pers : null);
    out.disciple.push(ch);
  }
  return out;
}

// 兼容旧调用：返回段落数组（离线段等仍然可用）
function idleReport(sinceMs) {
  const d = idleReportData(sinceMs);
  if (!d.disciple.length) return ['宗门平静，弟子在秘境中默默打磨。'];
  const paras = [];
  for (const ch of d.disciple) {
    let s = genLab(ch.gen) + (ch.name ? '·' + ch.name : '') + '，' +
      (ch.lines.length ? ch.lines.map(function (x) { return x.txt; }).join('，') : '于秘境中历练');
    if (ch.runs) s += '，共历 ' + ch.runs + ' 局';
    if (ch.cause) s += '。' + ch.cause;
    if (ch.peakAtk) s += '（攻击峰值 ' + ch.peakAtk + '）';
    paras.push(s);
  }
  return paras;
}

// 时刻格式（本地时间 HH:MM）
function fmtClock(ms) {
  try {
    const d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  } catch (e) { return ''; }
}

// ★ 渲染编年史（双区）
function renderIdleReport(sinceMs) {
  sfx('banner');                     // ★ R60：归山见闻弹出
  const d = idleReportData(sinceMs);
  const since = sinceMs || G._seenAt || 0;
  const periodEvents = EVENTS.filter(function (_e) { return _e.t > since && _e.imp >= 4; });
  const master = currentMaster();
  let h = '';
  // ---- 宗主报信（归山见闻的"脸"）----
  h += '<div class="rp-master">宗主' + (master ? master.name : '?') +
    '禀：你不在的时候，宗门如下——</div>';
  // ---- 离线结算（你不在时宗门没闲着；2026-10-16 新增）----
  if (G._offline && !G._offlineShown) {
    const off = G._offline;
    const awaySec = Math.max(off.away, (Date.now() - (G._savedAt || Date.now())) / 1000);
    const hrs = awaySec / 3600;
    const dur = hrs >= 1 ? hrs.toFixed(1) + ' 小时' : Math.round(awaySec / 60) + ' 分钟';
    const over = awaySec > off.away + 60;   // 超过封顶 ⇒ 收益按上限算
    h += '<div class="rp-offline">☾ 上次离线 ' + fmtDay(G._savedAt) + ' · 离开 ' + dur +
      ' —— 击杀 ' + off.kills + '，灵气 +' + off.qi +
      '，素材 +' + (off.drops * P.OFFLINE_MATERIAL_PER_DROP) + '。' +
      (over ? '（收益按 ' + P.OFFLINE_CAP_HOURS + ' 小时封顶）' : '') +
      (off.died ? '这一代没等到你回来，坐化了。' : '') + '</div>';
  }
  // ---- 各部长老轶事（活气）----
  h += renderElderAnecdotes(periodEvents);
  // ---- 上区：弟子生平（带时刻 + 强度跃升）----
  if (!d.disciple.length) {
    h += '<p class="cr-empty">宗门平静，弟子在秘境中默默打磨。</p>';
  } else {
    for (const ch of d.disciple) {
      h += '<div class="cr-ch">';
      h += '<div class="cr-hd"><b>' + genLab(ch.gen) + (ch.name ? ' · ' + ch.name : '') + '</b>';
      const gp = growthPhrase(ch.startAtk, ch.peakAtk);
      if (gp) h += '<span class="cr-grow">' + gp + '</span>';
      h += '</div>';
      if (ch.lines.length) {
        h += '<div class="cr-body">';
        const ord = {};                       // 同类型事件在本代内的序号（防撞词）
        for (const l of ch.lines) {
          let txt = l.txt;
          if (l.e) {
            const o = ord[l.e.type] || 0; ord[l.e.type] = o + 1;
            const p = eventPhrase(l.e.type, l.e, ch.gen, ch.name, o, ch.pers);
            if (p) txt = p;
          }
          h += '<div class="cr-li cr-' + l.k + '">' + fmtClock(l.t) + '　' + txt + '</div>';
        }
        h += '</div>';
      } else {
        h += '<div class="cr-body"><div class="cr-li">于秘境中默默打磨</div></div>';
      }
      const parts = [];
      if (ch.runs) parts.push('共历 ' + ch.runs + ' 局');
      if (ch.cause) parts.push(ch.cause);
      const ep = realmEpithet(ch.tier);
      if (ep) parts.push('「' + ep + '」');
      h += '<div class="cr-ft">' + parts.join(' · ') + '</div></div>';
    }
  }
  // ---- 下区：宗门账 + 换代轶事 ----
  const sectLines = [];
  for (const ch of d.disciple) {
    for (const s of ch.sect) {
      let txt = s.txt;
      if (s.e) { const p = eventPhrase(s.e.type, s.e, ch.gen, ''); if (p) txt = p; }
      sectLines.push({ t: s.t, txt: genLab(ch.gen) + ' · ' + txt, k: s.k });
    }
  }
  // 换代轶事（长老/宗主交班）：归山见闻里"送别"那一下
  for (const _e of periodEvents) {
    if (_e.type === 'elder_change') {
      sectLines.push({ t: _e.t, txt: '宗主' + (master ? master.name : '') + '禀：' +
        (_e.fac || '宗门') + '换人了，' + (_e.old || '') + ' 卸任，' + (_e.neu || '') + ' 接手。', k: 'handover' });
    }
  }
  if (sectLines.length) {
    sectLines.sort(function (a, b) { return a.t - b.t; });
    h += '<div class="cr-sect"><div class="cr-sect-hd">宗门账</div>';
    for (const s of sectLines) {
      h += '<div class="cr-si cr-' + s.k + '">' + fmtClock(s.t) + '　' + s.txt + '</div>';
    }
    h += '</div>';
  }
  return h;
}

// ---------------- 叙事层（Round 51）：长老 / 宗主 / 归山见闻活气 ----------------
//
// 设计依据：叙事层文案库_待审.md（§六 ③ 事件池 / §十一 长老轶事 / §十二 宗主）
//   目标：归山见闻从"冷事件列表"变成"宗主向你禀报 + 各部长老带着本设施弟子做事"。
//   零数值改动：所有内容只把现有 EVENTS / SECT / ROSTER 翻译成人话。

// 共享事件描述池（归山见闻 + 生平卷共用；相邻代按 gen%长度 轮换，不撞词）
// 键 = 实际 ev() 事件类型；文档里尚未触发的类型（drop_myth/boss_kill/...）留作扩展钩子
const EVENT_POOL = {
  break: [
    '他在秘境最深处破了{realm}。那道关他卡了很久。',
    '他是在秘境破了{realm}。旁边没人。',
    '突破{realm}那天，铜牌自己亮的。他没告诉任何人。',
    '{realm}成了。他坐在崖边，没笑，也没喊。',
    '那道关他一个人磨了很久，{realm}是在一个雨夜破的。',
    '他没跟人说，只身进了秘境。出来时，已经是{realm}了。',
  ],
  dujie_ok: [
    '他过了雷劫。那道劫劈了他三次，他站起来三次。',
    '雷劫落尽，他睁着眼。{realm}成了。',
    '护道阵亮了一夜。天亮时，他站在灰里，{realm}成了。',
  ],
  dujie_fail: [
    '他试了一次{realm}雷劫。没成。道伤留到了最后。',
    '那次雷劫之后，他再没提过{realm}两个字。',
    '第三次冲{realm}，还是同一个时辰、同一个法子。还是没成。',
  ],
  tourney: [
    '他在擂台站到了第{rank}。台下没人再敢上台。',
    '擂台连胜{rank}场。最后一场他只用了三息。',
    '台上的人换了一茬又一茬。他一直站着，没人记得他第几场开始的。',
  ],
  death_old: [
    '寿元到了。他是坐着走的，手还攥着那柄断剑。',
    '寿元尽。他死在自己的床上，灯是最后灭的。',
    '同辈一个个进了土。他坐在那儿，比谁都久。',
  ],
  death_battle: [
    '他没回来。宗门去取遗物时，剑还在他手里。',
    '他死在秘境深处。旁边是那头他最后挑的怪。',
    '他不是打不过，是不肯退。最后一刻剑还往前递。',
  ],
  legacy_get: [
    '他去秘境取回了先辈遗落的{n}件。铜灯亮到后半夜，他一件件擦干净。',
    '先辈的东西散在秘境各处。他这一趟，找回了{n}件。',
    '第三代遗落的三件，他认得出每一件的来历。他说得出第三代的灵根。',
  ],
  sect_rank: [
    '宗门升到了{阶名}。山门那块匾，换成了新的。',
    '这一代，宗门从{旧阶}挤进了{新阶}。账上第一次有了结余。',
    '三阶到四阶卡了很久。这代弟子打回来的东西，把这道坎填平了。',
  ],
  sect_up: [
    '{name}又升了一级。炉火没断过。',
    '宗门把{name}扩了一层。能同时带的人，多了一倍。',
  ],
  // —— 扩展钩子（当前版本尚未触发的事件类型，预留文案，触发即共享）——
  drop_myth: [
    '他在秘境的乱石缝里摸到{量}{宝名}——神话品，上面还沾着上一任主人的血。',
    '小怪身上竟然有{量}{宝名}——神话品。弟子一把夺了过来。',
    '他带回{量}{宝名}，神话品。宝库里没人认得上面的纹，他也不说从哪来。',
  ],
  elite_king: [
    '他去挑了{mob}——你走前念叨了两天没敢去的那头。',
    '他把{mob}的角拔了下来，搁在宗门门口。那角比人还高。',
    '{mob}盘踞秘境三年，没人敢惹。他进去时没跟任何人说。',
  ],
  boss_kill: [
    '他讨了秘境的{mob}，回来时半身是血，怀里抱着那颗首级。',
    '{mob}的鳞甲他剥了一半带走，剩下一半还晾在秘境深处。',
    '他一个人去的{mob}。宗门听说时，那颗首级已经挂在山门上了。',
  ],
  ascend: [
    '他破空而去。宗门史册上这一页只有八个字。',
    '他踏破了那层天。再没人见过他。',
  ],
  rule_change: [
    '门规改了一条。原来的"不恋战"划掉，换成"见强则避，见弱则清"。',
    '山门那面墙，每年重抄一次。今年多了半行，是关于收尸的。',
  ],
  fac_build: [
    '新锻部落成了。炉火第一天就没熄。',
    '藏经阁加了一进。新架子上还空着，等后人来填。',
  ],
  fac_upgrade: [
    '传功阁扩了一层。能同时带的人，多了一倍。',
    '宝库加了锁。你以前随手塞的东西，现在有了固定位置。',
  ],
  heritage_gain: [
    '{量}{宝名}进了宝库，神话品。它原本躺在秘境深处，现在摆在最里头。',
    '先辈的传承残卷凑齐了。宗门底蕴那一栏，第一次满。',
  ],
  pvp_win: [
    '邻宗来犯，被打退了。他们留在山门口的那面旗，现在当柴烧。',
    '这一战，宗门名号第一次传到了境外。',
  ],
  pvp_lose: [
    '邻宗踩过了我们的线。这一代，山门后头那片林子没了。',
    '输了一场。荣誉栏减了，但人都在。',
  ],
  lineage_break: [
    '这一代，没人接传承。宗门的功法，空了一阵。',
    '断层了。下一代入门时，得从头教。',
  ],
};

// 占位符兜底填充（避免渲染出 undefined）
function fillPhrase(s, e, name) {
  e = e || {};
  const prevRank = SECT_RANKS[Math.max(0, (SECT.rank | 0) - 1)];
  const fb = {
    name: name || '',
    zone: e.zone || '秘境',
    mob: e.name || '那头妖',
    slot: SLOT_NOUN[e.slot] || e.slot || '件',
    宝名: e.nm || SLOT_NOUN[e.slot] || e.slot || '装备',
    量: itemMeasure(e.slot, e.wp),
    realm: e.realm || '',
    n: (e.n != null) ? e.n : ((e.lost != null) ? e.lost : ''),
    rank: (e.rank != null) ? e.rank : '',
    tier: (e.tier != null) ? e.tier : '',
    old: e.old || '', neu: e.neu || '', fac: e.fac || '',
    阶名: e.rank || '', 新阶: e.rank || '', 旧阶: prevRank ? prevRank.n : '微末',
    底蕴: (SECT.legacyPool.length + SECT.lostLegacy.length),
  };
  return String(s).replace(/\{([^{}]+)\}/g, function (_, k) { return (fb[k] != null) ? fb[k] : ''; });
}
// 事件变体选取：同一代内【同类型事件按出现顺序】顺次取不同变体
//   ⇒ 彻底修掉"这一代所有突破都同一句"（2026-10-16 用户反馈）
function eventPhrase(type, e, gen, name, ord, pers) {
  // ★ 突破：优先用该弟子【性格】的说法（文案库 §七"语气决定怎么说"）
  if (type === 'break' && pers && BREAK_BY_PERS[pers]) {
    const pa = BREAK_BY_PERS[pers];
    return fillPhrase(pa[(((ord | 0) % pa.length) + pa.length) % pa.length], e, name);
  }
  const arr = EVENT_POOL[type];
  if (!arr || !arr.length) return null;
  const idx = ((((gen | 0) + (ord | 0)) % arr.length) + arr.length) % arr.length;
  return fillPhrase(arr[idx], e, name);
}

// ---- 成长文案（取代归山见闻里的"攻击 X → Y"数值；修仙小说味，2026-10-16）----
//   依据：叙事层文案库_待审.md §十四 ①。按这一代的成长倍数分档说人话。
function growthPhrase(startAtk, peakAtk) {
  if (!peakAtk) return '';
  if (!startAtk || startAtk <= 0) return '刚下山，看不出深浅';
  const r = peakAtk / Math.max(1, startAtk);
  if (r >= 2.0) return '脱胎换骨——走时那点底子，回来已不算数';
  if (r >= 1.5) return '比走时强了一大截';
  if (r >= 1.2) return '明显比来时强';
  if (r >= 1.05) return '略有长进';
  if (r > 1.0) return '比走时强些';
  return '还是那点底子';
}
// ---- 境界评价（生平 / 史册用；全文唯一允许"评价"的地方，与 §〇 白描基准的例外）----
//   依据：§十四 ②。索引 = 大境界序号（0 炼气 … 11 金仙），入参是【原始档】需过 realmOf。
const REALM_EPITHET = [
  '刚引气入体，还是个练家子',
  '筑了道基，一方小门派里排得上号',
  '金丹境内，无人能敌',
  '元婴出窍，方圆千里没人敢直呼其名',
  '神识化虚，一州之地随他走',
  '炼虚的修为，搁哪个宗门都是镇派的老祖',
  '法体合一，这一界的对手数得出来',
  '大乘将成，人间已无敌手',
  '只差一道雷劫，就是另一个世界的人',
  '陆地神仙，凡人见一面都是机缘',
  '天仙之姿，人间已留不住',
  '金仙临世，此界再容不下他',
];
function realmEpithet(tier) {
  return REALM_EPITHET[realmOf(tier | 0)] || '';
}

// ---------------- 弟子性格（2026-10-16 · 文案库 §七「第一步」）----------------
//   12 个性格 + 出现率权重。每弟子抽 1 个；死亡时随史册存（老档无 ⇒ 降级走通用池）。
//   ⚠️ 权重是文案库标的 [PLACEHOLDER]，待真机跑 20 代再调（§七 失败信号 B）。
const PERS_W = {
  惜物: 1.5, 好胜: 1.5, 孤行: 1.5, 寡言: 1.5, 守规: 1.5, 急躁: 1.5,
  念旧: 1.5, 认命: 1.5, 怕死: 1.0, 认死理: 1.0, 逐利: 1.0, 野: 0.6,
};
function rollPers() {
  const ks = Object.keys(PERS_W);
  let tot = 0; for (const k of ks) tot += PERS_W[k];
  let r = Math.random() * tot;
  for (const k of ks) { r -= PERS_W[k]; if (r <= 0) return k; }
  return ks[0];
}
// 突破按性格（"语气决定怎么说"）——每种 2 句，同代内按出现顺序轮换
const BREAK_BY_PERS = {
  惜物: ['破{realm}那天，他把磨穿的那副护手收进了箱子。',
    '{realm}成了。他先捡回落在崖下的旧剑，才回头看自己。'],
  好胜: ['{realm}成了。他站着，像还没打过瘾。',
    '破{realm}的时候他咬着牙——嫌慢。'],
  孤行: ['{realm}是他在秘境里一个人破的。回来谁也没提。',
    '他没等谁护道，{realm}那道关自己撞了过去。'],
  寡言: ['破了{realm}。他只点了下头。',
    '{realm}成了。他一个字没说，第二天照旧下山。'],
  守规: ['{realm}破了。他先把洞府收拾干净才出来。',
    '他按老法子一步没跳，{realm}是自己熟的。'],
  急躁: ['{realm}，他嫌等得慢，硬闯了一回——好在成了。',
    '破{realm}那天他比谁都急，劫还没散就往外冲。'],
  念旧: ['破{realm}用的是上一代留下的那柄剑。',
    '{realm}成了，他对着旧剑说了半句什么。'],
  认命: ['{realm}到了。他没高兴，也没不高兴。',
    '该来的来了，{realm}。他随手把门推开。'],
  怕死: ['他绕开那条路，从别处慢慢磨到了{realm}。',
    '破{realm}前，他把退路看了三遍。'],
  认死理: ['{realm}卡了很久。他一遍遍试同一个法子。',
    '别人劝他换条路，他不肯。{realm}就是这么磕出来的。'],
  逐利: ['刚破{realm}，他先问这东西能换多少。',
    '{realm}一到手，他就盘算着下一趟去哪座秘境划算。'],
  野: ['{realm}是在杀得最狠的时候破的。',
    '他不管什么劫不劫，{realm}是拿命换的。'],
};

// ---------------- 生平卷（Round 53 · 文案库 §二~§五）----------------
//   谓词决定挑哪条记录，语气决定怎么说 —— 这里存"语气"那一半（按性格）与派生表。
//   入道：按性格（§二 各条）
const PERS_IN = {
  惜物: '他是从捡东西开始的。别人打完仗走了，他蹲在雪地里，把没被人捡走的碎铁一件件翻出来。',
  好胜: '他不肯打比自己弱的。第一场仗就挑了高一档的怪，输了，第二天又去。',
  孤行: '他从不等人。同门结伴进秘境，他总是一个人先进去，出来时不打招呼。',
  寡言: '他在门里待了两年。这两年里他说过的话，能被数出来。',
  怕死: '第一次出门，他进去不到一炷香就撤了。没人笑他——笑他的人都死了。',
  认死理: '他认定一条路就不换。第一次冲高境失败，第二次还是同一个时辰、同一个法子。',
  守规: '门规第一条是"不恋战"。他照做了三十年，一次没破例。',
  急躁: '他出剑比谁都快，收不住。第一年打坏了两柄剑。',
  念旧: '别人记的是宗门的事，他记的是人的名字。',
  认命: '他知道自己资质差。他没争过。',
  逐利: '他算得很清楚——哪一层划算，哪一层不划算。',
  野: '门规贴了三张，他一张没记住。',
};
//   降级（这一代没爆高权重事件）：按性格（§二 各条）
const PERS_FLAT = {
  惜物: '他没打过大仗。他这辈子的记录，大半是"某某某件被修好了"。',
  好胜: '这一代没什么可打的。他天天在擂台上等人来。',
  孤行: '他没什么可记的。宗门连他是哪天回来的都说不准。',
  寡言: '这一代，没有记录。',
  怕死: '这一代平安。宗门账上没有他的名字，也没有他丢的东西。',
  认死理: '他这辈子只做一件事——往上冲。冲到哪一步，史册上没写。',
  守规: '他这辈子的记录只有四个字，"遵规无过"。',
  急躁: '这一代很短。他还没来得及让人记住名字。',
  念旧: '他没做什么。他只是把旧名册抄了一遍。',
  认命: '这一代，无事。',
  逐利: '这一代收益持平。他没有冒过一次险，也没有亏过一次。',
  野: '这一代风平浪静。这不像他。',
};
//   收场：按结局（不按性格——性格的"收场"样例会与真实死因打架，见 §十四 说明）
const END_BY_CAUSE = {
  old_age: ['寿元到了。他没留下话。', '寿元尽。灯是最后灭的。', '同辈一个个进了土。他坐在那儿，比谁都久。'],
  battle: ['他没回来。', '他死在秘境深处，旁边是那头他最后挑的怪。', '他不是打不过，是不肯退。'],
  handover: ['他把传承交出去，然后就走了。', '他不想拖累后辈。这话他没说。'],
  ascend: ['他破空而去。'],
};
//   墓志：按结局（§五 · 全文唯一允许一句冷抒情的地方）
const EPITAPH = {
  old_age: ['他没成大器。但他把你给的东西，一件没丢。', '活得比同辈都久。到最后一刻，他自己把灯吹了。',
    '这辈子没出过什么大风头。宗门账上，他那一栏是平的。'],
  battle: ['他死在没人看见的地方。宗门去取遗物的时候，剑还在手里。', '他不是打不过，是不肯退。',
    '遗落的东西现在还搁在那儿。等后辈的修为到了，就能取回来。'],
  handover: ['他挑了个好日子把传承交出去，然后就走了。', '他不想拖累后辈。这句话他没说，但谁都看得出来。'],
  ascend: ['他破空而去。宗门史册上，这一页只有八个字。'],
  short: ['他来过很短一阵。名字还没来得及被人记住。'],
};
//   称号（§四）：取该代 imp 最高的记录类型 → 查表 → gen%长度
const TITLES = {
  drop_myth: ['拾珍者', '天予', '得宝人'],
  dujie_ok: ['渡劫者', '过雷人'],
  dujie_fail: ['折道', '雷下客', '半途人'],
  elite_king: ['屠王', '断角', '斩首人'],
  boss_kill: ['破军', '讨逆'],
  legacy_get: ['拾遗', '归物'],
  life_gain: ['续命', '借寿'],
  tourney: ['擂主', '台上人'],
  extract: ['知退', '见好'],
  ascend: ['飞仙', '破空'],
  death_battle: ['遗路人', '留骨', '未归'],
  _none: ['无名', '未题'],
};
// 死亡时派生（此刻 EVENTS 还是这一代的）
function deriveTitle(gen) {
  let top = null, best = -1, lg = 0;
  for (const e of EVENTS) {
    if ((e.imp | 0) > best) { best = e.imp | 0; top = e.type; }
    if (e.type === 'legacy_get') lg++;
  }
  let arr = TITLES[top] || TITLES._none;
  if (lg >= 3) arr = ['收尸人'];          // ★ 条件称号（§四）
  return arr[((gen | 0) % arr.length + arr.length) % arr.length];
}
// 死亡时快照：imp 最高的那条（生平卷"风光"用；EVENTS 换弟子会清空，必须此刻存）
function topEventSnap() {
  let top = null, best = -1;
  for (const e of EVENTS) if ((e.imp | 0) > best) { best = e.imp | 0; top = e; }
  return top ? Object.assign({}, top) : null;
}
const BIO_CAUSE = { old_age: '善终', battle: '战死秘境', handover: '主动交接' };
function bioPick(arr, gen) { return arr[((gen | 0) % arr.length + arr.length) % arr.length]; }
// ★ 代次显示：永不出现"第 0 代"（真实代次从 1 起，这是防脏数据的兜底）
function genLab(g) { return '第 ' + Math.max(1, g | 0) + ' 代'; }

// ★ 生平卷：把一代的一生翻成人话（三幕 + 遗物 + 墓志；§三）
function bioVol(x) {
  if (!x) return '';
  const pers = x.pers || null;
  const chr = (SECT.chronicle[x.gen] || []).length;
  if ((x.runs | 0) <= 1 && chr < 5) {         // 短命代 ⇒ 只写一行（§三 降级）
    return '<div class="bio-epi">' + bioPick(EPITAPH.short, x.gen) + '</div>';
  }
  const asc = !!(x.hi && x.hi.type === 'ascend');
  const ck = asc ? 'ascend' : (x.cause === 'battle' ? 'battle' : (x.cause === 'handover' ? 'handover' : 'old_age'));
  let out = '';
  if (pers && PERS_IN[pers]) out += '<div class="bio-act"><span>入道</span>' + PERS_IN[pers] + '</div>';
  if (x.hi && x.hi.type) {                     // 风光 = 该代最重的那条记录（借事件池说人话）
    const ph = eventPhrase(x.hi.type, x.hi, x.gen, x.name, 0, pers);
    if (ph) out += '<div class="bio-act"><span>风光</span>' + ph + '</div>';
  } else if (pers && PERS_FLAT[pers]) {
    out += '<div class="bio-act"><span>风光</span>' + PERS_FLAT[pers] + '</div>';
  }
  out += '<div class="bio-act"><span>收场</span>' + bioPick(END_BY_CAUSE[ck], x.gen) + '</div>';
  const c = x.carried | 0, l = x.lost | 0;
  out += '<div class="bio-act"><span>遗物</span>' +
    (c || l ? ('带回 ' + c + ' 件' + (l ? '，遗落 ' + l + ' 件' : '，没丢东西') + '。')
      : '他没留下东西，也没丢东西。') + '</div>';
  out += '<div class="bio-epi">' + bioPick(EPITAPH[ck], x.gen) + '</div>';
  return out;
}
// ★ 史册历代卡的正文（称号 / 境界评价 / 一句小传 / 结局 · 享寿）
function bioCardBody(x) {
  const parts = [];
  if (x.title) parts.push('「' + x.title + '」');
  parts.push('修至<b>' + (x.realmAtDeath || P.REALMS[realmOf(x.tier | 0)] || '—') + '</b>');
  const ep = realmEpithet(x.tier);
  if (ep) parts.push('<span class="arc-ep">「' + ep + '」</span>');
  let out = parts.join(' · ');
  if (x.hi && x.hi.type) {                     // 一句小传
    const ph = eventPhrase(x.hi.type, x.hi, x.gen, x.name, 0, x.pers);
    if (ph) out += '<br>' + ph;
  }
  out += '<br><i>' + (BIO_CAUSE[x.cause] || x.cause || '—') +
    ' · 共历 ' + (x.runs | 0) + ' 局' +
    (x.carried ? ' · 带回 ' + x.carried + ' 件' : '') +
    (x.lost ? ' · 遗落 ' + x.lost + ' 件' : '') +
    (x.lifeYears != null ? ' · 享寿 ' + x.lifeYears + ' 载' : '') + '</i>';
  return out;
}
// 结局颜色条（§六 ② 改前原型：绿在门 / 红战死 / 灰善终）
function bioBarCls(x) {
  if (!x) return 'in';
  if (x.cause === 'battle') return 'dead';
  if (x.hi && x.hi.type === 'ascend') return 'asc';
  if (x.cause === 'handover') return 'hand';
  return 'in';
}
// ★ 宗门本纪（宗门卷 §十 · 六段；门风段只写行为痕迹，定性待议事堂）
function renderSectVol() {
  const gens = SECT.generation || 0;
  const rk = (typeof SECT_RANKS !== 'undefined' && SECT_RANKS[SECT.rank | 0]) ? (SECT_RANKS[SECT.rank | 0].n || '') : '';
  const head = (SECT.elders && SECT.sectMaster && SECT.elders[SECT.sectMaster])
    ? SECT.elders[SECT.sectMaster].name : '守门的那位';
  let h = '<div class="arc-sec">卷首 · 宗门本纪</div><div class="sect-vol">';
  h += '<div class="bio-act"><span>立宗</span>老祖带着' + head +
    '在秘境边上落了脚，草棚一搭，宗门就算立了——彼时' + head + '还只是个守门的。</div>';
  if (gens < 5) {
    h += '<div class="bio-epi">这只宗门还小。它才刚开始。</div></div>';
    return h;
  }
  h += '<div class="bio-act"><span>攀升</span>从微末挤到了' + (rk || '眼下这一阶') +
    '，靠的是几代人往回扛的东西。</div>';
  const rules = (SECT_DOCTRINE.rules || []).length;
  h += '<div class="bio-act"><span>门风</span>门规立过 ' + rules +
    ' 条，训话改过 ' + (SECT_DOCTRINE.spoken || 0) + ' 次。<i>（这只宗门变成了什么脾气，等议事堂定了再说。）</i></div>';
  const myths = (SECT.legacyPool || []).filter(function (i) { return (i.q | 0) >= 4; }).length;
  h += '<div class="bio-act"><span>底蕴</span>宝库里搁着 ' + myths + ' 件神话' +
    (SECT.lostLegacy.length ? '；丢在外面的还有 ' + SECT.lostLegacy.length + ' 件，没取回来。' : '。') + '</div>';
  h += '<div class="bio-epi">这只宗门，是你不在时自己长起来的。</div></div>';
  return h;
}
// ---- 时刻（MM-DD HH:MM，给"上次离线"用）----
function fmtDay(t) {
  if (!t) return '—';
  const d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 长老任期基准：前线最高修为寿元（锚定"前线最高修为寿元"）
function frontlineTopLifeYears() {
  const rl = Math.min(11, Math.ceil((SECT.topTier || 0) / 2));
  let y = P.LIFESPAN_YEARS;
  for (let i = 1; i <= rl; i++) y += LIFE_PER_REALM[i];
  return Math.min(LIFE_CAP_YEARS, y);
}
// 任期（代）：以"年"计再除 100（1 代≈100 年）；宗主倍率更大
function elderTenureGens(isMaster) {
  const base = frontlineTopLifeYears();
  const mul = isMaster ? (10 + 2 * (SECT.rank | 0)) : (5 + (SECT.rank | 0));
  return Math.max(3, Math.round(base * mul / P.LIFESPAN_YEARS));
}
function currentMaster() {
  if (!SECT.elders || !SECT.sectMaster) return null;
  return SECT.elders[SECT.sectMaster] || null;
}
function masterName() { const m = currentMaster(); return m ? m.name : ''; }

// 保证长老班底存在（建宗 / 读档 / 旧档缺失都走这）
function ensureElders() {
  if (!SECT.elders || typeof SECT.elders !== 'object') SECT.elders = {};
  const allThere = FACILITIES.every(function (f) {
    return SECT.elders[f.id] && SECT.elders[f.id].name;
  });
  if (allThere && SECT.sectMaster) return;
  for (const f of FACILITIES) {
    if (!SECT.elders[f.id] || !SECT.elders[f.id].name) {
      SECT.elders[f.id] = {
        name: makeDiscipleName(),
        sinceGen: SECT.generation,
        dieGen: SECT.generation + elderTenureGens(false),
        facility: f.id,
      };
    }
  }
  if (!SECT.sectMaster) SECT.sectMaster = 'gate';
}

// 每代检查长老/宗主任期，到则交班（写进 EVENTS，归山见闻会呈现）
function rotateElders() {
  if (!SECT.elders) { ensureElders(); return; }
  const changed = [];
  for (const f of FACILITIES) {
    const el = SECT.elders[f.id];
    if (!el || !el.name) continue;
    if ((SECT.generation | 0) >= (el.dieGen | 0)) {
      const old = el.name;
      const neu = pickNewElderName(f.id, old);
      SECT.elders[f.id] = {
        name: neu, sinceGen: SECT.generation,
        dieGen: SECT.generation + elderTenureGens(false), facility: f.id,
      };
      changed.push({ fac: f.name, old: old, neu: neu });
    }
  }
  // 宗主
  if (SECT.sectMaster && SECT.elders[SECT.sectMaster]) {
    const m = SECT.elders[SECT.sectMaster];
    if ((SECT.generation | 0) >= (m.dieGen | 0)) {
      const old = m.name;
      const cand = FACILITIES.filter(function (x) { return x.id !== SECT.sectMaster; })
        .map(function (x) { return SECT.elders[x.id]; }).filter(function (e) { return e && e.name; });
      const neu = cand.length ? cand[0].name : makeDiscipleName();
      const newKey = cand.length ? cand[0].facility : 'gate';
      SECT.sectMaster = newKey;
      changed.push({ fac: '宗门', old: old, neu: neu, master: true });
    }
  }
  for (const c of changed) {
    log('✦ 长老交班：' + c.fac + '，' + c.old + ' 卸任，' + c.neu + ' 接手', 'sys');
    ev('elder_change', 6, { fac: c.fac, old: c.old, neu: c.neu, reason: c.master ? 'master' : 'retire' });
  }
}
function pickNewElderName(fac, oldName) {
  const used = {};
  for (const k in SECT.elders) if (SECT.elders[k] && SECT.elders[k].name) used[SECT.elders[k].name] = 1;
  const backs = (ROSTER.list || []).filter(function (d) {
    return d.alive && d.role === 'back' && d.name !== oldName && !used[d.name];
  }).sort(function (a, b) { return (b.tier || 0) - (a.tier || 0); });
  if (backs.length) {
    const pick = backs[0];
    if (pick.post !== fac) pick.post = fac;
    return pick.name;
  }
  for (let i = 0; i < 12; i++) {
    const nm = makeDiscipleName();
    if (!used[nm]) return nm;
  }
  return makeDiscipleName();
}

// 长老带本设施弟子（活气来源）
const ELDER_DEFAULT = {
  forge: '{name}带着{d}守在炉边敲了半日，火星子没断过。',
  train: '{name}把新来的娃们拢在廊下，{d}跟着一遍遍拆那式起手。',
  script: '{name}就着窗光抄谱，{d}在旁研墨，指节都黑了。',
  vault: '{name}把里间的锁挨个拨了一遍，{d}在后面数着数目。',
  legacy: '{name}守着那几样旧物，{d}替他拂灰，半点不让落。',
  life: '{name}守着丹炉，{d}闻味就知道火候差半分。',
  gate: '{name}倚着门框，{d}跟着他打量每一个入门的新弟子。',
  arch: '{name}在殿里添了半页，{d}在旁研墨，墨还没干。',
  hall: '议事堂还空着，{name}的活儿暂由宗主自己扛。',
};
// 设施 → 触发覆盖的事件类型（与 §十一 ③ 同）
// ★ 2026-10-16 用户："部门没产出就别报告了；山门只有门规[变]换的时候才有报告"
//   ⇒ 只保留「山门·门规变动」这一条特别事（立规/换规都会发 rule_add）。
//   其余原来借长老之口报的（渡劫/取回传承/延寿…）都不是那部的产出，撤掉。
const ELDER_COVER = {
  gate: { type: 'rule_add', tmpl: '{name}把新门规念了一遍，{d}在后面跟着念，末了补一句"都记着"。' },
};
// 本设施当前轮值的几名弟子名（取不到则降级：用任意在册弟子凑，保证有活气）
function elderDisciples(fac, n) {
  const all = (ROSTER.list || []).filter(function (d) { return d.alive && d.name; });
  const mine = all.filter(function (d) { return d.post === fac; }).map(function (d) { return d.name; });
  const out = mine.slice(0, n);
  if (out.length < n && all.length) {
    // ★ 兜底：从任意在册弟子按【设施序号错开】取，
    //   否则各部都带同样几个人（在册人够多时就能区分开）
    const fi = Math.max(0, FACILITIES.findIndex(function (f) { return f.id === fac; }));
    const names = all.map(function (d) { return d.name; });
    const off = (fi * n) % names.length;
    for (let k = 0; k < names.length && out.length < n; k++) {
      const nm = names[(off + k) % names.length];
      if (out.indexOf(nm) < 0) out.push(nm);
    }
  }
  return out.slice(0, n);
}
// ---- 各部产出 → 人话（2026-10-16 用户："有产出就写出，没产出别写有的没的"）----
//   ⚠️ 设施产出大多是被动系数（传功阁 +% 修炼 / 宝库 +% 掉落…），不是可数的"件数"；
//      只有锻造部（素材）/ 延寿丹房（续命人数）是可数量 ⇒ 前者给具体数，其余给叙述。
function facYieldLine(fid, y) {
  const b = (y && y.b) || {};
  switch (fid) {
    case 'forge':
      return y.mats > 0 ? ('炉子没熄过——出了 ' + y.mats + ' 素材。') : '';
    case 'train': {
      const v = (b.qi || 1) - 1;
      if (v <= 0) return '';
      return v >= 0.15 ? '把弟子的修炼往上抬了一大截。'
        : v >= 0.06 ? '把弟子的修炼又催了一程。' : '给弟子的修炼添了把火。';
    }
    case 'script': {
      const v = (b.gf || 1) - 1;
      if (v <= 0) return '';
      return v >= 0.08 ? '残卷翻出了眉目，功法上的门道厚了一层。'
        : '把旧卷理了理，功法上略有眉目。';
    }
    case 'vault': {
      const v = (b.drop || 1) - 1;
      if (v <= 0) return '';
      return v >= 0.08 ? '库房理过一遍，出东西比往常顺了不少。'
        : '把库房归了归，出东西比往常顺手。';
    }
    case 'legacy':
      return y.ilvl > 0 ? '从旧物里又拣出几件够看的。' : '';
    case 'life':
      return y.healed > 0 ? ('给 ' + y.healed + ' 名驻宗弟子续了命。') : '';
    case 'hall': {
      const v = (b.info || 1) - 1;
      return v > 0 ? '把这一届的章程理了理。' : '';
    }
    default:
      return '';   // gate / arch 不产东西（gate 只在门规/训话事件时另写）
  }
}
function renderElderAnecdotes(periodEvents) {
  if (!SECT.elders) return '';
  const y = G.facYield;
  let h = '<div class="rp-elders"><div class="rp-elders-hd">各部长老</div>';
  let any = false;
  for (const f of FACILITIES) {
    const el = SECT.elders[f.id];
    if (!el || !el.name) continue;
    const ds = elderDisciples(f.id, 3);
    const dStr = ds.length ? ds.join('、') : '';
    const cov = ELDER_COVER[f.id];
    const hit = cov && periodEvents && periodEvents.some(function (e) { return e.type === cov.type; });
    let body = '';
    if (hit) {
      // 前缀已有长老名 ⇒ 去掉模板开头重复的 {name}
      body = cov.tmpl.replace(/^\{name\}/, '').replace(/\{name\}/g, el.name).replace(/\{d\}/g, dStr);
    } else {
      const out = y ? facYieldLine(f.id, y) : '';
      if (!out) continue;                        // ★ 没产出就不写（用户要求）
      body = (dStr ? '带着 ' + dStr + '，' : '') + out;
    }
    h += '<div class="rp-el"><b>' + f.name + '·' + el.name + '</b>：' + body + '</div>';
    any = true;
  }
  if (!any) h += '<div class="rp-el rp-el-quiet">各部照常当值 —— 这一届没什么拿得出手的产出。</div>';
  h += '</div>';
  return h;
}


// ---------------- 三之二、弟子与宗门（赛马娘式多世代结构）----------------
//
// 设计依据（用户提案 + 上班摸鱼节奏）：
//   一天 3 次操作（早上 / 中午 / 下班前），间隔约 3 小时
//   ⇒ 一个弟子寿元 = 3 小时 ⇒ 一天 2~3 代
//
//   弟子结束的两种方式：
//     · 寿元耗尽 ⇒ 善终回宗门，传承【完整】带回
//     · 战斗身亡 ⇒ 传承遗落在死地，需后辈去取（或宗门花资源赎）
//
//   不在线时：自动培养下一代（按自动规则挑传承），避免"卡住"
// ---------------- 三之二·十五点五、秘境属性倾向（Round 14）----------------
//
// 回答用户的问题："这个秘境倾向属性是干嘛用的？"
//
//   没有它：怪的五行【均匀随机】⇒ 相性期望恒为 ×1.00
//           ⇒ 玩家没有"换武器/换秘境"的动机 ⇒ 五行系统等于装饰
//
//   有了它：每个秘境有自己的【主导五行】⇒ 该属性的怪占比高
//           ⇒ 相性会明显偏正或偏负 ⇒ 五行才是【决策】
//
//   与灵根的配合（这是两个系统真正的联动）：
//     单灵根弟子 → 只能吃一种相性 ⇒ 必须【挑秘境】（去对自己有利的）
//     四/五灵根   → 同调厚、能应付多样 ⇒ 【不挑也能打】
//   ⇒ "选秘境"本身变成了 BD 的一部分。
const ZONE_BIAS = [
  { name: '金煞谷', wx: '金', bias: 0.50, desc: '庚金之气充盈 · 木属性弟子克之' },
  { name: '青木林', wx: '木', bias: 0.50, desc: '万木参天 · 土属性弟子克之' },
  { name: '玄水渊', wx: '水', bias: 0.50, desc: '寒潭千尺 · 火属性弟子克之' },
  { name: '赤炎窟', wx: '火', bias: 0.50, desc: '地火奔涌 · 水属性弟子克之' },
  { name: '厚土塬', wx: '土', bias: 0.50, desc: '黄沙万里 · 木属性弟子克之' },
  { name: '五行交汇', wx: null, bias: 0.20, desc: '五行均布 · 相性中性（默认）' },
];
const ZB = { idx: 0 };
function zbReset() { ZB.idx = 0; }
function zbNow() { return ZONE_BIAS[ZB.idx] || ZONE_BIAS[ZONE_BIAS.length - 1]; }
// ★ 秘境选择的权重（Round 15）
//
//   权重顺序（用户指定）：
//     ① 自己的【主灵根】       —— 最想去
//     ② 【生主灵根】的五行     —— "木生火" ⇒ 火灵根会去木属性秘境
//     ③ 自己的【副灵根】       —— 退而求其次
//     ④ 【宗门其他弟子】的属性 —— "帮同门收集物资"
//     ⑤ 五行交汇（兜底）
//
//   权重是相对值，最后归一化成概率。
const ZB_W = { main: 6, sheng: 3, sub: 2, peer: 1.2, fallback: 1 };
// 宗门其他弟子（历代）的属性 —— 从 history 里取不到就现造几个"在门弟子"
function sectPeers() {
  if (!SECT.peers) {
    // 在门弟子：随机 3~5 个，各有主属性（"同门"）
    const n = 3 + Math.floor(Math.random() * 3);
    SECT.peers = [];
    for (let i = 0; i < n; i++) {
      SECT.peers.push({ name: '同门' + (i + 1), wx: WX_ALL[Math.floor(Math.random() * WX_ALL.length)] });
    }
  }
  return SECT.peers;
}
function zbWeights() {
  const g = lgOf();
  const main = g.main, sub = g.sub;
  const peers = sectPeers().map(x => x.wx);
  return ZONE_BIAS.map(z => {
    let w = ZB_W.fallback;   // 兜底（五行交汇 / 完全无关的）
    if (!z.wx) return { z, w: ZB_W.fallback };
    if (main && z.wx === main) w = Math.max(w, ZB_W.main);
    // 相生：谁生我的主灵根 ⇒ 那个属性的秘境
    if (main && SHENG[z.wx] === main) w = Math.max(w, ZB_W.sheng);
    if (sub && z.wx === sub) w = Math.max(w, ZB_W.sub);
    if (peers.indexOf(z.wx) >= 0) w = Math.max(w, ZB_W.peer);
    return { z, w };
  });
}
function zbAdvance() {
  sfx('scene');                      // ★ R60：换秘境
  // ★ 按权重随机（而不是均匀）—— 用户要求"权重优先自己的主灵根…"
  let ws = zbWeights();
  // ★★ Round 34 挂点3：门规排除的秘境（负门规"避赤炎窟"）
  const bans = SECT_DOCTRINE.bannedZones || [];
  if (bans.length) {
    const kept = ws.filter(function (x) { return bans.indexOf(x.z.name) < 0; });
    if (kept.length) ws = kept;   // 全被排除时不过滤，否则无路可走
  }
  const tot = ws.reduce((a, x) => a + x.w, 0);
  let r = Math.random() * tot;
  for (const x of ws) { r -= x.w; if (r <= 0) { ZB.idx = ZONE_BIAS.indexOf(x.z); return zbNow(); } }
  ZB.idx = ZONE_BIAS.length - 1;
  return zbNow();
}
// 这次为什么来这个秘境（给日志用，呼应"帮同门收集物资"）
function zbReason() {
  const g = lgOf(), z = zbNow();
  if (!z.wx) return '五行交汇 · 常规历练';
  if (g.main && z.wx === g.main) return '本命秘境 · 主灵根' + g.main;
  if (g.main && SHENG[z.wx] === g.main) return '相生秘境 · ' + z.wx + '生' + g.main;
  if (g.sub && z.wx === g.sub) return '副灵根' + g.sub + '秘境';
  const peers = sectPeers();
  if (peers.some(p => p.wx === z.wx)) return '为同门收集' + z.wx + '属性物资';
  return '常规历练';
}

// ---------------- 三之二·十七、宗门建设（阶段 1 · Round 18）----------------
//
// 来源：设计规格_宗门建设.md（用户 Round 18 提案）
//
// 设计的根本矛盾（为什么必须转移）：
//   弟子的时间尺度 = 一局 5 分钟 / 一生 3 小时  ← 短、随机、会死
//   宗门的建设尺度 = 永久累积                  ← 长、可规划
//   ⇒ 在弟子身上做 BD 决策 = 每 3 小时把设计推倒重来 ⇒ 与挂机节奏冲突
//
// 本阶段（单弟子下就能做）：
//   ① 素材搬到宗门（跨代累积）
//   ② 基础锻造部（用素材造装备）
//   ③ 门装模板（11 部位 × 5 档优先度）
//   ④ 训话（三轴权重 + 加权换装，含"弟子自己发挥"的 margin）
//   ⑤ 自动分解（用不上的按模板分解 → 素材回宗门）

// ---- ① 宗门资源（素材跨代累积）----
const SECT_RES = {
  materials: 0,        // 素材（弟子分解回收 → 宗门锻造）
  forged: 0,           // 累计锻造件数（统计）
  spent: 0,            // 累计消耗素材（统计）
  reforged: 0,         // 重铸次数（Round 19）
  transferred: 0,      // 转移次数
  targeted: 0,         // 定向次数
};

// ---- ③ 门装模板：11 部位 × 5 档优先度 ----
//
//   档位含义（玩家用一句话表达意图，而不是拖拽）：
//     0 不想要 · 1 无所谓 · 2 想要 · 3 很想要 · 4 必须要
const TEMPLATE_LEVELS = ['不想要', '无所谓', '想要', '很想要', '必须要'];
const TEMPLATE_TIERS = [0, 1, 2, 3, 4];
// 每个部位可选的"要什么"（属性轴）
const TEMPLATE_AXES = ['生存', '修行', '收益'];
const SECT_DOCTRINE = {
  // 11 部位 × 3 轴 的优先度（默认全 2 = 想要）
  want: {},
  // 训话三轴权重（0~100）—— ★ 每代重置
  speech: { survive: 50, train: 50, profit: 50 },
  // 训话预设
  preset: 'balanced',
  // ★ Round 54：议事堂定的 BD 打法倾向（bal/atk/def/spd）—— 跨代保留
  bias: 'bal',
  // ★★ Round 34：门规（训话的「上锁版」）—— 【跨代保留，不随 doctrineReset 清空】
  //   用户决策："上锁吧"
  //   Z1：硬约束遵守率 80%（留出「活人是例外」的戏）
  //   Z2：负门规 = 同一秘境战死 3 次自动成形，上限 2 条
  //   Z3：负门规可解除，但花荣誉点
  //   Z4：门规上限 3 条
  rules: [],
  // 负门规的候选：某秘境战死次数 { '赤炎窟': 2 }
  deathByZone: {},
  // 被负门规排除的秘境
  bannedZones: [],
};
// ---- 门规参数（Z1~Z5）----
const RULE_CFG = {
  MAX_RULES: 3,            // Z4：门规上限
  MAX_NEGATIVE: 2,         // Z2：负门规上限
  OBEY: 0.80,              // Z1：硬约束遵守率（80% ⇒ 留出「活人是例外」）
  NEG_TRIGGER: 3,          // Z2：同一秘境战死几次触发负门规
  LIFT_COST: 150,          // Z3：解除一条负门规的荣誉点
  MAX_BAN_ZONES: 2,        // 最多排除几个秘境
};
const AXIS_NAME = { survive: '生存', train: '修行', profit: '收益' };

// ---------------- 门规（Round 34）----------------
// 用户决策："上锁吧" ⇒ 门规 = 训话的上锁版
//   · 立规：把当前训话三轴锁为门规，跨代保留 + 署名
//   · 硬约束：遵守率 80%（Z1）—— 留出「活人是例外」
//   · 负门规：同一秘境战死 3 次自动成形（Z2），可花荣誉解除（Z3）

// ★★ 遵守率的摇法（Round 34 关键）：
//   Z1 的 80% 不能"每件装备摇一次"（会让 doctrineScore 排序自相矛盾）
//   ⇒ 按【批次】摇：一次换装决策 / 一局 / 一代，只摇一次，整批一致
//   这样 20% 的"例外"表现为【整个一局偶尔不守规】，而不是"一件件随机"
//   —— 这才符合"活人是例外"的叙事（而不是"活人随机抽风"）
const RULE_ROLL = { survive: null, train: null, profit: null, gen: -1 };
function ruleRollReset(reason) {
  RULE_ROLL.survive = Math.random() < RULE_CFG.OBEY;
  RULE_ROLL.train   = Math.random() < RULE_CFG.OBEY;
  RULE_ROLL.profit  = Math.random() < RULE_CFG.OBEY;
  RULE_ROLL.reason = reason || '';
  // 记录"例外"发生了多少次（挂机报告用）
  const any = ['survive','train','profit'].some(function (k) {
    return SECT_DOCTRINE.rules.some(function (r) { return r.kind === 'positive' && r.axis === k; })
      && !RULE_ROLL[k];
  });
  if (any) { RULE_ROLL.exceptions = (RULE_ROLL.exceptions || 0) + 1; }
}
function ruleCount(kind) {
  return SECT_DOCTRINE.rules.filter(function (r) {
    return !kind || r.kind === kind;
  }).length;
}
function ruleHasAxis(axis) {
  return SECT_DOCTRINE.rules.some(function (r) { return r.axis === axis && r.kind === "positive"; });
}
// 立规：把训话的某一轴锁为门规
function ruleAdd(axis) {
  if (!AXIS_NAME[axis]) return false;
  if (ruleCount("positive") >= RULE_CFG.MAX_RULES) {
    log("门规已满（上限 " + RULE_CFG.MAX_RULES + " 条），需先废规", "warn");
    return false;
  }
  if (ruleHasAxis(axis)) { log("该轴已有门规", "warn"); return false; }
  const r = {
    id: "r" + (SECT_DOCTRINE.rules.length + 1) + "_" + Date.now(),
    axis: axis,
    value: SECT_DOCTRINE.speech[axis] || 50,
    bornGen: SECT.generation,
    by: (DISCIPLE && DISCIPLE.name) || ("第" + SECT.generation + "代"),
    kind: "positive",
    scope: axis === "survive" ? "retreat" : (axis === "train" ? "equip" : "zone"),
  };
  SECT_DOCTRINE.rules.push(r);
  log("✦ 立门规〈" + AXIS_NAME[axis] + "·" + r.value + "〉@ 第 " + r.bornGen + " 代 · " + r.by, "break");
  ev("rule_add", 9, { axis: axis, value: r.value, by: r.by });
  return true;
}
// 废规（玩家主动废掉一条正门规）
function ruleDrop(id) {
  const i = SECT_DOCTRINE.rules.findIndex(function (r) { return r.id === id; });
  if (i < 0) return false;
  const r = SECT_DOCTRINE.rules[i];
  if (r.kind === "negative") return ruleLift(id);   // 负门规走"解除"
  SECT_DOCTRINE.rules.splice(i, 1);
  log("✦ 废门规〈" + AXIS_NAME[r.axis] + "〉", "warn");
  return true;
}
// 解除负门规（Z3：花荣誉点）
function ruleLift(id) {
  const i = SECT_DOCTRINE.rules.findIndex(function (r) { return r.id === id; });
  if (i < 0) return false;
  const r = SECT_DOCTRINE.rules[i];
  if (SECT.honor < RULE_CFG.LIFT_COST) {
    log("解除积弊需荣誉 " + RULE_CFG.LIFT_COST + "（现有 " + SECT.honor + "）", "warn");
    return false;
  }
  SECT.honor -= RULE_CFG.LIFT_COST;
  SECT_DOCTRINE.rules.splice(i, 1);
  if (r.zone) {
    const z = SECT_DOCTRINE.bannedZones.indexOf(r.zone);
    if (z >= 0) SECT_DOCTRINE.bannedZones.splice(z, 1);
    if (SECT_DOCTRINE.deathByZone) delete SECT_DOCTRINE.deathByZone[r.zone];
  }
  log("✦ 破除积弊〈" + (r.zone || AXIS_NAME[r.axis]) + "〉（耗荣誉 " + RULE_CFG.LIFT_COST + "）", "ok");
  return true;
}
// 弟子结束 ⇒ 记录战死秘境；触发则自动成形负门规（Z2）
function ruleNoteDeath(zone) {
  if (!zone) return null;
  SECT_DOCTRINE.deathByZone = SECT_DOCTRINE.deathByZone || {};
  SECT_DOCTRINE.deathByZone[zone] = (SECT_DOCTRINE.deathByZone[zone] || 0) + 1;
  const n = SECT_DOCTRINE.deathByZone[zone];
  if (n < RULE_CFG.NEG_TRIGGER) return null;
  if (ruleCount("negative") >= RULE_CFG.MAX_NEGATIVE) return null;
  if (SECT_DOCTRINE.bannedZones.indexOf(zone) >= 0) return null;
  if (SECT_DOCTRINE.bannedZones.length >= RULE_CFG.MAX_BAN_ZONES) return null;
  const r = {
    id: "n" + Date.now(),
    axis: "survive", value: 100,
    bornGen: SECT.generation,
    by: "第 " + SECT.generation + " 代弟子的血",
    kind: "negative",
    scope: "zone", zone: zone,
  };
  SECT_DOCTRINE.rules.push(r);
  SECT_DOCTRINE.bannedZones.push(zone);
  log("✦ 积弊成形〈避" + zone + "〉—— " + n + " 代弟子死在这里", "break");
  ev("rule_neg", 9, { zone: zone, n: n });
  return r;
}
// 门规的生效值（硬约束）：优先门规，否则训话
//   Z1：遵守率 80% ⇒ 有 20% 的时刻"活人是例外"，按训话走
function ruleValue(axis) {
  const r = SECT_DOCTRINE.rules.find(function (x) {
    return x.kind === "positive" && x.axis === axis;
  });
  if (!r) return null;
  // ★ 读【本批次】的遵守结果（不是每次现摇）
  if (RULE_ROLL[axis] === false) return null;      // 这一批当"例外"，走训话
  return { v: r.value, by: r.by, gen: r.bornGen };
}
// 该轴的有效权重（门规 > 训话；按批次遵守）
function ruleEffective(axis) {
  const has = SECT_DOCTRINE.rules.some(function (x) {
    return x.kind === "positive" && x.axis === axis;
  });
  const rv = ruleValue(axis);
  if (rv) return { v: rv.v, src: "rule", by: rv.by, axis: axis };
  return { v: SECT_DOCTRINE.speech[axis], src: (has ? "exception" : "speech"), axis: axis };
}
function doctrineReset() {
  SECT_DOCTRINE.want = {};
  for (const s of Object.keys(SLOT_ZONE)) {
    SECT_DOCTRINE.want[s] = { 生存: 2, 修行: 2, 收益: 2 };
  }
  SECT_DOCTRINE.speech = { survive: 50, train: 50, profit: 50 };
  SECT_DOCTRINE.preset = 'balanced';
  applyBias();     // ★ 议事堂 · 打法倾向：跨代保留（每代重置后重新盖上去）
  // ★★ Round 34 门规（关键的一行）：
  //   门规【不随换代重置】—— 这正是它存在的意义。
  //   下面这些字段在 doctrineReset 里【刻意不清】：
  //     SECT_DOCTRINE.rules        （立过的规矩跨代保留）
  //     SECT_DOCTRINE.bannedZones  （负门规排除的秘境跨代保留）
  //     SECT_DOCTRINE.deathByZone  （战死计数是长期统计）
  //   ⇒ 注释在此，防止后来者"顺手补上"而破坏门规
}
// 训话预设（对应设计文档 §4.1）
const SPEECH_PRESETS = {
  steady:   { name: '稳健', survive: 80, train: 40, profit: 20, desc: '优先活着回来' },
  balanced: { name: '均衡', survive: 50, train: 50, profit: 50, desc: '不偏不倚' },
  greedy:   { name: '拼命', survive: 20, train: 80, profit: 70, desc: '优先变强与收获' },
  profit:   { name: '贪财', survive: 30, train: 40, profit: 90, desc: '优先多拿东西' },
};
// ---- 议事堂 · BD 打法倾向（Round 54 · R180 定案）----
//   用户："议事堂用来改变弟子的倾向" ⇒ 四档：偏攻 / 偏守 / 偏速 / 均衡。
//   落法（v1）：一档 = 【门装模板】的一套部位优先级（弟子按这个方向配装）。
//   ⚠️ 数字是 [PLACEHOLDER]：先给"方向"，待真机看手感再调。
//   ⚠️ 与「训话」分工：倾向决定**配装**（要什么部位），训话决定**行为**（打多深 / 何时撤）——
//      两者独立，不互相覆盖。
const BIAS = {
  bal: { name: '均衡', desc: '不偏不倚，哪个部位顺眼用哪个。', slots: null },
  atk: {
    name: '偏攻', desc: '先看打得疼不疼：主手 / 副手 / 戒指 / 项链 优先。',
    slots: { 主手: 4, 副手: 4, 戒指: 3, 项链: 3, 手: 3, 足: 3, 头: 2, 肩: 1, 胸: 1, 腰: 1, 腿: 1 },
  },
  def: {
    name: '偏守', desc: '先看扛不扛得住：头 / 肩 / 胸 / 腰 / 腿 优先。',
    slots: { 主手: 1, 副手: 1, 戒指: 2, 项链: 3, 手: 2, 足: 2, 头: 4, 肩: 4, 胸: 4, 腰: 4, 腿: 4 },
  },
  spd: {
    name: '偏速', desc: '先看快不快：手 / 足 优先。',
    slots: { 主手: 3, 副手: 3, 戒指: 2, 项链: 2, 手: 5, 足: 5, 头: 2, 肩: 1, 胸: 1, 腰: 1, 腿: 2 },
  },
};
// 把当前倾向写进【门装模板】（doctrineReset 之后调用 ⇒ 跨代保留）
function applyBias() {
  const b = BIAS[SECT_DOCTRINE.bias] || BIAS.bal;
  for (const s of Object.keys(SECT_DOCTRINE.want)) {
    const lv = b.slots ? (b.slots[s] != null ? b.slots[s] : 2) : 2;
    SECT_DOCTRINE.want[s] = { 生存: lv, 修行: lv, 收益: lv };
  }
}
function setBias(key) {
  if (!BIAS[key]) return false;
  SECT_DOCTRINE.bias = key;
  applyBias();
  log('✦ 议事堂定下打法倾向：' + BIAS[key].name, 'ok');
  return true;
}
function setSpeech(presetKey) {
  const p = SPEECH_PRESETS[presetKey];
  if (!p) return false;
  SECT_DOCTRINE.speech = { survive: p.survive, train: p.train, profit: p.profit };
  SECT_DOCTRINE.preset = presetKey;
  return true;
}
// ★ 换装 margin：保命权重越高越保守（"弟子按方针走，但不完全听话"）
function speechMargin() {
  // ★★ Round 34：门规优先（挂点2 · 撤退阈值）
  const eS = ruleEffective('survive');
  const sv = eS.v / 100;                            // 0~1
  return 0.02 + 0.18 * sv;                          // 2% ~ 20%
}

// ---- ④ 装备的相对价值（不再用"总评分"）----
//
//   ⚠️ 关键：不能用"总评分最高"（会退化成"哪件数字大穿哪件" = BD 深度归零）
//   改为按【训话三轴】分别评估，再加权。
function itemAxes(it) {
  if (!it) return { 生存: 0, 修行: 0, 收益: 0 };
  const main = SLOT_MAIN[it.slot];
  const v = it.mainVal || 0;
  let 生存 = 0, 修行 = 0, 收益 = 0;
  // 主属性按类型归轴
  if (main === '防御') { 生存 += v * 1.6; }
  else if (main === '生命') { 生存 += v * 0.55; }
  else if (main === '速度') { 收益 += v * 0.5; 生存 += v * 0.35; }
  else if (main === '攻击') { 收益 += v * 1.0; }
  else { 修行 += v * 0.3; }
  // 词缀按【描述文本】归轴
  //   ⚠️ 词缀对象只有 id/name/zone/base/tier/desc/cost（没有 stat/v）
  //      ⇒ 只能从 desc + zone 推断它属于哪条轴
  for (const id of (it.affixes || [])) {
    const a = AFFIX_BY_ID[id];
    if (!a) continue;
    const txt = (a.desc || '') + (a.cost || '');
    const mag = (a.base || 1.4) * 6;   // 词缀量级（大概 8~12）
    if (/防御|生命|免死|回血|反伤|闪避|格挡|抵抗|减伤|抗性/.test(txt)) 生存 += mag;
    else if (/修为|灵气|同调|相性|五行/.test(txt)) 修行 += mag;
    else 收益 += mag;
  }
  return { 生存, 修行, 收益 };
}
// 按训话加权 + 门装模板的偏好
function doctrineScore(it) {
  if (!it) return -1e9;
  const ax = itemAxes(it);
  const w = SECT_DOCTRINE.want[it.slot] || { 生存: 2, 修行: 2, 收益: 2 };
  // ★★ Round 34：门规优先于训话（挂点1 · 换装）
  //   ruleEffective 读【本批次】的遵守结果 ⇒ 同一批排序内部一致
  const eS = ruleEffective('survive'), eT = ruleEffective('train'), eP = ruleEffective('profit');
  const sp = { survive: eS.v, train: eT.v, profit: eP.v };
  // 模板优先度 0~4 ⇒ 权重 ×0.5 ~ ×1.5
  const wS = (sp.survive / 50) * (0.5 + w.生存 * 0.25);
  const wT = (sp.train / 50) * (0.5 + w.修行 * 0.25);
  const wP = (sp.profit / 50) * (0.5 + w.收益 * 0.25);
  // 门规生效时额外加权（"规矩"比"方针"更硬）
  const kS = eS.src === 'rule' ? 1.15 : 1, kT = eT.src === 'rule' ? 1.15 : 1, kP = eP.src === 'rule' ? 1.15 : 1;
  return kS * ax.生存 * wS + kT * ax.修行 * wT + kP * ax.收益 * wP;
}

// ---- ⑤ 自动换装：按训话 + 模板，逐个部位决策 ----
//
//   与 bestEquip（手动点击穿一件）的区别：这个函数扫描【整个背包】，
//   对每个部位决定"要不要换上背包里最好的那件"。
function assembleBest(st) {
  if (!st) st = playerStats();
  let changed = 0, scrapped = 0;
  // ★ Round 23：过滤掉【数据不完整】的装备（slot/shape 缺失）
  //   ⚠️ 实测会崩："Cannot read properties of undefined (reading 'cells')"
  //      —— 背包里出现过 slot=undefined 的脏数据
  //      不管它从哪来，都不该让整个换装崩掉
  const bag = G.bag.filter(x => !x.kind2 && x.slot && Array.isArray(x.shape));
  const _bad = G.bag.length - bag.length - G.bag.filter(x => x.kind2).length;
  if (_bad > 0) G._badItems = (G._badItems || 0) + _bad;
  if (!bag.length) return { changed, scrapped };
  // 当前穿着（按部位取锚点）
  const worn = {};
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (c && c._anchor) worn[c.slot] = c;
    }
  }
  const margin = speechMargin();
  // 每个部位只看本位区的候选
  for (const slot of Object.keys(SLOT_ZONE)) {
    const zone = SLOT_ZONE[slot];
    const zc = G.zones[zone];
    if (!zc) continue;
    const cur = worn[slot];
    const cands = bag.filter(x => x.slot === slot);
    if (!cands.length) continue;
    let best = null, bestScore = cur ? doctrineScore(cur) : -1;
    for (const c of cands) { const s = doctrineScore(c); if (s > bestScore) { bestScore = s; best = c; } }
    if (!best) continue;
    // ★ 换装判据：必须超过当前 × (1 + margin)
    //   margin 由【保命】权重决定 —— 保命高则保守，不轻易换
    const curScore = cur ? doctrineScore(cur) : 0;
    if (cur && bestScore <= curScore * (1 + margin)) continue;
    // 试着放：先卸下该部位旧件
    if (cur) unequipAt(cur);
    // 找位置放（本位区优先，放不下就别的分区）
    let placed = false;
    for (const zn of [zone].concat(Object.keys(G.zones))) {
      const z2 = G.zones[zn];
      if (!z2) continue;
      const [w, h] = best.shape;
      for (let y = 0; y <= z2.h - h && !placed; y++) for (let x = 0; x <= z2.w - w && !placed; x++) {
        if (canPlace(best, zn, x, y)) { place(best, zn, x, y); placed = true; }
      }
      if (placed) break;
    }
    if (!placed) { if (cur) place(cur, cur._z || zone, 0, 0); continue; }
    G.bag.splice(G.bag.indexOf(best), 1);
    if (cur) G.bag.push(Object.assign({}, cur, { _gain: null, _new: false }));
    changed++;
  }
  return { changed, scrapped };
}
// ★ Round 23：自动学功法 / 法宝（弟子自己挑，不用玩家手点）
//
//   用户："弟子会自动穿装备，选择对应功法？"
//
//   原来：功法书/法宝掉进背包后，要玩家【手点】才会学（点击 = grantGongfa/grantFabao）
//        ⇒ 挂机时永远不会学 ⇒ 弟子战力缺一大块
//   现在：每局结束时自动把背包里的功法书/法宝学掉
//         按 gfPriority（玩家预设的功法优先度）+ 法宝槽位挑，挑不上的留在背包
// ★ Round 24（用户要求）：槽满时，从【已拥有】的法宝里自动挑最合适的
//   "等后面掉落了其他的功法就选合适自己的"
//   判据：按玩家的 gfPriority（功法优先度）；法宝则按【本源 cost】粗排（后续可细化）
function autoPickSpecs() {
  // 法宝：选本源最高的一件（近似"最强"）
  if (FB.eq.length >= FABAO_SLOTS && FABAO_SLOTS > 0) {
    const owned = FABAO.filter(f => FB_OWNED[f.id]);
    if (owned.length) {
      let best = FB.eq[0];
      for (const x of FB.eq) { const cur = FABAO_BY_ID[x]; if (cur && FABAO_BY_ID[best] && cur.cost > FABAO_BY_ID[best].cost) best = x; }
      for (const f of owned) {
        const bf = FABAO_BY_ID[best];
        if (!bf || f.cost > bf.cost) best = f.id;   // 更"本源"的替换
      }
      if (best && FB.eq.indexOf(best) < 0) {
        FB.eq = [best];
        log('✦ 换用更相宜的法宝·' + FABAO_BY_ID[best].name, 'ok');
      }
    }
  }
  return true;
}

function autoLearnSpecs() {
  const learned = [];
  // 功法：按玩家优先度顺序学
  const gfBooks = G.bag.filter(x => x.kind2 === 'gongfa');
  for (const b of gfBooks) {
    if (!GF_BY_ID[b.gfId]) continue;
    if (GF_KNOWN[b.gfId]) {           // 已有 ⇒ 直接丢弃（不占背包）
      G.bag.splice(G.bag.indexOf(b), 1);
      continue;
    }
    if (grantGongfa(b.gfId)) {
      learned.push('功法·' + GF_BY_ID[b.gfId].name);
      G.bag.splice(G.bag.indexOf(b), 1);
    }
  }
  // 法宝：槽位有空就装，满了【只换更好的】否则留着
  const fbItems = G.bag.filter(x => x.kind2 === 'fabao');
  for (const b of fbItems) {
    if (!FABAO_BY_ID[b.fbId]) continue;
    if (FB_OWNED[b.fbId]) {           // 已有 ⇒ 丢弃
      G.bag.splice(G.bag.indexOf(b), 1);
      continue;
    }
    if (FB.eq.length < FABAO_SLOTS) {
      if (grantFabao(b.fbId)) {
        learned.push('法宝·' + FABAO_BY_ID[b.fbId].name);
        G.bag.splice(G.bag.indexOf(b), 1);
      }
    }
    // 槽满 ⇒ 留在背包（玩家可手动替换）
  }
  if (learned.length) {
    log('✦ 弟子自行参悟：' + learned.join('、'), 'ok');
    ev('auto_learn', 5, { n: learned.length });
  }
  return learned;
}


// ---- ⑤ 自动分解：用不上的按模板分解 → 素材回宗门 ----
//
//   用户原话："多出来的装备全部分解，变成素材，后面素材待会宗门"
//
//   ⚠️ 改前按"每部位固定保留 3 件"，但一局掉落只有 ~9 件且分布在 9 个部位
//      ⇒ 一件都不分解 ⇒ 素材永远为 0（实测发现）
//   改后按【分区剩余容量】保留：能穿下的就留着当备胎，穿不下的全分解。
function autoScrapByDoctrine() {
  let n = 0, mats = 0;
  const bag = G.bag.filter(x => !x.kind2);
  if (!bag.length) return { n, mats };
  // 每个部位的"备胎额度" = 该部位本位区的剩余格子数（穿不下的就是多余）
  const quota = {};
  for (const slot of Object.keys(SLOT_ZONE)) {
    const z = G.zones[SLOT_ZONE[slot]];
    quota[slot] = z ? Math.max(1, Math.floor(z.w * z.h / 3)) : 2;
  }
  const keep = {};
  const bySlot = {};
  for (const it of bag) (bySlot[it.slot] = bySlot[it.slot] || []).push(it);
  for (const s of Object.keys(bySlot)) {
    // 按【训话 + 模板】评分排序，分数低的先分解
    bySlot[s].sort((a, b) => doctrineScore(b) - doctrineScore(a));
    const q0 = quota[s] || 2;
    for (let i = q0; i < bySlot[s].length; i++) keep[bySlot[s][i].id] = true;
  }
  for (let i = G.bag.length - 1; i >= 0; i--) {
    const it = G.bag[i];
    if (it.kind2 || !keep[it.id]) continue;
    mats += disenchantValue(it);
    G.bag.splice(i, 1);
    G.disenchanted++; n++;
  }
  if (mats) log('分解 ' + n + ' 件用不上的装备 → 宗门素材 +' + mats, 'sys');
  SECT_RES.materials += mats;
  return { n, mats };
}
// ---- ② 基础锻造部：用素材造装备 ----
//
//   用户原话："宗门就可以用素材打造出门装"
const FORGE_RECIPES = [
  { slot: '主手', q: 3, mats: 60, name: '兵器坊' },
  { slot: '副手', q: 3, mats: 40, name: '副手' },
  { slot: '头',   q: 3, mats: 36, name: '冠帽' },
  { slot: '项链', q: 3, mats: 30, name: '项饰' },
  { slot: '肩',   q: 3, mats: 38, name: '护肩' },
  { slot: '胸',   q: 3, mats: 70, name: '护甲' },
  { slot: '腰',   q: 3, mats: 34, name: '腰带' },
  { slot: '手',   q: 3, mats: 30, name: '护手' },
  { slot: '戒指', q: 3, mats: 30, name: '指环' },
  { slot: '腿',   q: 3, mats: 50, name: '护腿' },
  { slot: '足',   q: 3, mats: 34, name: '战靴' },
];
function forgeCost(recipe) {
  // 成本随修为档上升（弟子的 ilvl 高了，装备也贵）
  return Math.round(recipe.mats * (1 + G.tier * 0.22));
}
function canForge(recipe) { return SECT_RES.materials >= forgeCost(recipe); }
function forge(recipe) {
  const cost = forgeCost(recipe);
  if (SECT_RES.materials < cost) { log('素材不足（需 ' + cost + '）', 'warn'); return null; }
  SECT_RES.materials -= cost;
  SECT_RES.spent += cost;
  const ilvl = 1 + G.tier * DROP.ILVL_PER_TIER;
  const isW = (recipe.slot === '主手' || recipe.slot === '副手');
  const it = makeSlotItem(recipe.slot, ilvl, recipe.q, isW ? 'sword' : null);
  it._forged = true;
  it._new = true;
  G.bag.push(it);
  SECT_RES.forged++;
  log('✦ 锻造 ' + QUALITIES[recipe.q] + ' ' + recipe.slot +
    '（耗素材 ' + cost + '）', 'ok');
  ev('forge', 6, { slot: recipe.slot, q: recipe.q, cost });
  return it;
}
// 一次造齐（能造就造）—— 挂机友好
function forgeAll() {
  let n = 0;
  for (const r of FORGE_RECIPES) {
    if (canForge(r)) { if (forge(r)) n++; }
  }
  return n;
}

// ---------------- 三之二·二十一、天赋 + 寿元（Round 21）----------------
//
// 用户想法（Round 21）：
//   "随着不同境界的突破，给的越来越多寿元，偶尔可能有个天赋异禀的弟子，寿元得的久也正常"
//   "但是怎么限制我觉得该好好想一想，来个天妒英才？越年轻的天赋越高修炼的越快，危险率适度上涨？"
//   "延寿要不给+5（或者多少）年/级这样？"
//
// 设计（见 层2数值.md §61）：
//   ① 天赋 5 档（每代随机）—— 影响【寿元 + 修炼速度】，但天然触发【天妒】
//   ② 突破给寿元（大境界给，越高的境界给越多）
//   ③ ★ 天妒英才：进度超前（相对"应活年数"）⇒ 渡劫失败率上涨
//      —— 这就是"自然的限制"：天才一路狂飙，天妒随之而来
//   ④ 寿元上限 160 年（硬卡，防正反馈失控）
const TALENTS = [
  { id: 'fan',  name: '凡骨', rate: 0.32, life: -0.15, speed: 0.90, desc: '资质平平 · 寿元短' },
  { id: 'ping', name: '平庸', rate: 0.30, life: 0.00, speed: 1.00, desc: '中人之资' },
  { id: 'shang', name: '上乘', rate: 0.22, life: 0.10, speed: 1.10, desc: '资质上乘 · 寿元略长' },
  { id: 'tian', name: '天骄', rate: 0.13, life: 0.22, speed: 1.22, desc: '万中无一 · 修炼极快' },
  { id: 'yao',  name: '妖孽', rate: 0.03, life: 0.35, speed: 1.35, desc: '百年难遇 · 但天妒英才' },
];
const TAL = { id: null, name: '', life: 0, speed: 1, desc: '' };
function talReset() {
  let r = Math.random(), acc = 0, pick = TALENTS[TALENTS.length - 1];
  for (const g of TALENTS) { acc += g.rate; if (r < acc) { pick = g; break; } }
  Object.assign(TAL, pick);
  return TAL;
}
function talOf() { return (TAL.id ? TAL : talReset()); }
// ★ 天赋条目（Round 57）挂在这两条上：修炼速度 / 寿元
function talSpeedMul() { return talOf().speed * traitMul('speed'); }
function talLifeMul() {
  return (1 + talOf().life) * traitMul('life') *
    (1 - Math.min(0.25, talentEnvy() * 0.02));   // ★ 天妒：天赋太满 ⇒ 折寿
}

// ---------------- 天赋条目（Round 57 · 设计规格_天赋条目.md）----------------
//   用户拍板：① 旧的 5 档资质【融合】进来，就当"寿命向天赋"（每人恒定 1 条，即 TAL）
//             ② 同一根轴可以叠 ⇒ 在对位轴上吃负面（"天妒"的局部版）
//             ③ 高稀有度可以带一点代价（写进该条的 cost）
//   ⚠️ 全部数值 [PLACEHOLDER]，待真机跑 20 代校准。
const TRAIT_RAR = {
  tianming: { name: '天命', rate: 0.01, max: 1, color: '#e8c86a', score: 5 },
  juepin: { name: '绝品', rate: 0.05, max: 1, color: '#c08ae0', score: 3 },
  shangpin: { name: '上品', rate: 0.18, max: 1, color: '#6ea8fe', score: 2 },
  liangpin: { name: '良品', rate: 0.40, max: 2, color: '#7fbf7f', score: 1 },
  fanpin: { name: '凡品', rate: 1.00, max: 2, color: '#8a8577', score: 0 },
};
const TRAITS = [
  { id: 'weimian', name: '位面之子', rar: 'tianming', ax: 'speed', mul: 1.30, desc: '修炼速度 ×1.30' },
  { id: 'tianren', name: '天人合一', rar: 'tianming', ax: 'dujie', add: 0.12, desc: '突破成功率 +12%' },
  { id: 'qiyun', name: '气运加身', rar: 'tianming', ax: 'drop', mul: 1.35, desc: '掉落率 ×1.35' },
  { id: 'liba', name: '力拔山兮气盖世', rar: 'juepin', ax: 'atk', mul: 1.25, cost: { ax: 'life', mul: 0.92 }, desc: '攻击 ×1.25 · 寿元 −8%' },
  { id: 'lgqin', name: '灵根亲和', rar: 'juepin', ax: 'wx', mul: 1.10, desc: '五行相性 ×1.10' },
  { id: 'tongxuan', name: '通玄', rar: 'juepin', ax: 'qi', mul: 0.90, desc: '修为门槛 ×0.90' },
  { id: 'shenli', name: '天生神力', rar: 'shangpin', ax: 'atk', mul: 1.12, desc: '攻击 ×1.12' },
  { id: 'mingjing', name: '心如明镜', rar: 'shangpin', ax: 'dujie', add: 0.06, desc: '突破成功率 +6%' },
  { id: 'baimai', name: '百脉俱通', rar: 'shangpin', ax: 'speed', mul: 1.10, desc: '修炼速度 ×1.10' },
  { id: 'jingu', name: '筋骨强健', rar: 'liangpin', ax: 'hp', mul: 1.10, desc: '生命 ×1.10' },
  { id: 'ercong', name: '耳聪目明', rar: 'liangpin', ax: 'drop', mul: 1.10, desc: '掉落率 ×1.10' },
  { id: 'shouwen', name: '手稳', rar: 'fanpin', ax: 'atk', mul: 1.04, desc: '攻击 ×1.04' },
  { id: 'jixing', name: '记性好', rar: 'fanpin', ax: 'speed', mul: 1.04, desc: '修炼速度 ×1.04' },
  { id: 'naizhu', name: '耐得住', rar: 'fanpin', ax: 'life', mul: 1.03, desc: '寿元 +3%' },
];
const TRAIT_BY_ID = {};
TRAITS.forEach(function (t) { TRAIT_BY_ID[t.id] = t; });
// 同轴叠 ⇒ 对位轴吃负面（天妒的局部版）
const TRAIT_COUNTER = { atk: 'hp', hp: 'atk', speed: 'dujie', dujie: 'speed', drop: 'life', life: 'drop' };
const TRAIT_STACK_PEN = 0.06;      // 每多叠一条：对位 ×0.94  [PLACEHOLDER]
// 抽取：**3~4 条**（用户 2026-10-16 定）；每一条按【稀有度权重】抽档，
//   档有各自名额上限（max）⇒ 天然实现"稀有度越高给的越少"，最高档最多 1 条。
function rollTraits() {
  const out = [];
  const keys = Object.keys(TRAIT_RAR);
  const total = 3 + (Math.random() < 0.5 ? 0 : 1);          // 3~4 条
  const used = {};
  for (let i = 0; i < total; i++) {
    const avail = keys.filter(function (k) { return (used[k] || 0) < TRAIT_RAR[k].max; });
    if (!avail.length) break;
    let tot = 0; avail.forEach(function (k) { tot += TRAIT_RAR[k].rate; });
    let r = Math.random() * tot, pick = avail[avail.length - 1];
    for (const k of avail) { r -= TRAIT_RAR[k].rate; if (r <= 0) { pick = k; break; } }
    const pool = TRAITS.filter(function (t) { return t.rar === pick && out.indexOf(t.id) < 0; });
    if (!pool.length) continue;
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id);
    used[pick] = (used[pick] || 0) + 1;
  }
  return out;
}
function traitAxes() {
  const ids = (typeof DISCIPLE !== 'undefined' && DISCIPLE && DISCIPLE.traits) ? DISCIPLE.traits : [];
  const c = {}, m = {};
  for (const id of ids) {
    const t = TRAIT_BY_ID[id]; if (!t) continue;
    c[t.ax] = (c[t.ax] || 0) + 1;
    if (t.mul) m[t.ax] = (m[t.ax] || 1) * t.mul;
    if (t.cost) m[t.cost.ax] = (m[t.cost.ax] || 1) * t.cost.mul;    // ★ 自带代价
  }
  for (const ax of Object.keys(TRAIT_COUNTER)) {                     // ★ 同轴叠 ⇒ 对位吃负面
    const n = c[ax] || 0;
    if (n >= 2) { const ctr = TRAIT_COUNTER[ax]; m[ctr] = (m[ctr] || 1) * Math.pow(1 - TRAIT_STACK_PEN, n - 1); }
  }
  return { c: c, m: m };
}
function traitMul(ax) { return traitAxes().m[ax] || 1; }
function traitAdd(ax) {
  const ids = (DISCIPLE && DISCIPLE.traits) ? DISCIPLE.traits : [];
  let a = 0; for (const id of ids) { const t = TRAIT_BY_ID[id]; if (t && t.ax === ax && t.add) a += t.add; }
  return a;
}
// 天妒：总天赋强度越高 ⇒ 越"天妒其寿"（用户："你只要太强大，就会获得某方面的负面"）
function talentEnvy() {
  const ids = (DISCIPLE && DISCIPLE.traits) ? DISCIPLE.traits : [];
  let sc = 0;
  for (const id of ids) { const t = TRAIT_BY_ID[id]; if (t && TRAIT_RAR[t.rar]) sc += TRAIT_RAR[t.rar].score; }
  return sc;
}

// ---- 突破给寿元（大境界给，越高的境界给越多）----
//   用户："随着不同境界的突破，给的越来越多寿元"
const LIFE_PER_REALM = [0, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28];  // 按大境界序号（1~11）
const LIFE_CAP_YEARS = 160;    // ★ 硬上限（防"寿元→更多局→更多突破→更多寿元"正反馈失控）
// 寿元还剩多少【年】（用 lifeMax 当分母，避免基准漂移）
function lifeMaxSeconds() {
  const m = DISCIPLE.lifeMax || (P.LIFESPAN_HOURS * 3600);
  return m;
}
function lifeToYears2(sec) {
  const totalSec = lifeMaxSeconds();
  return Math.max(0, Math.round(sec / totalSec * P.LIFESPAN_YEARS * (lifeMaxYears() / P.LIFESPAN_YEARS)));
}
// 本代"总寿元年数"（base × 天赋 + 突破加成，硬卡上限）
function lifeMaxYears() {
  return Math.min(LIFE_CAP_YEARS,
    P.LIFESPAN_YEARS * talLifeMul() + sectBonus().lifeYear + (DISCIPLE.lifeGain || 0));
}
// 突破到大境界 rl 时给寿元（一次性加到 lifespanLeft）
function grantLifeOnRealm(rl) {
  const add = LIFE_PER_REALM[Math.min(rl, LIFE_PER_REALM.length - 1)] * talLifeMul();
  // 硬卡：总量不超过上限
  const cur = DISCIPLE.lifeGain || 0;
  const baseYears = P.LIFESPAN_YEARS * talLifeMul() + sectBonus().lifeYear;
  if (baseYears + cur >= LIFE_CAP_YEARS) return 0;
  const realAdd = Math.min(add, LIFE_CAP_YEARS - baseYears - cur);
  DISCIPLE.lifeGain = cur + realAdd;
  // 折算成秒，加到剩余寿元上
  const addSec = realAdd / P.LIFESPAN_YEARS * (P.LIFESPAN_HOURS * 3600);
  DISCIPLE.lifespanLeft += addSec;
  DISCIPLE.lifeMax = (DISCIPLE.lifeMax || P.LIFESPAN_HOURS * 3600) + addSec;
  log('✦ 突破至' + P.REALMS[Math.min(11, rl)] + '，寿元 +' + Math.round(realAdd) +
    ' 年（本代累计 +' + Math.round(DISCIPLE.lifeGain) + ' 年 · 总寿元 ' +
    Math.round(lifeMaxYears()) + ' 年）', 'break');
  ev('life_gain', 6, { realm: rl, years: Math.round(realAdd) });
  return realAdd;
}

// ---- ★ 天妒英才（Round 21）----
//
//   用户："越年轻的天赋越高修炼的越快，危险率适度上涨？"
//
//   实现：进度【超前】于"正常进度线" ⇒ 渡劫失败率上涨
//     正常进度线 = 100 年基础 + 各大境界应给的寿元
//     超前 20 年内不罚（正常波动）· 每超 1 年 +1.5% · 上限 +60%
function expectedYearsAt(tier) {
  const rl = Math.min(11, Math.ceil(tier / 2));
  let y = P.LIFESPAN_YEARS;
  for (let i = 1; i <= rl; i++) y += LIFE_PER_REALM[i];
  return y;
}
// 当前弟子的实际"年龄"（已活年数）
function livedYears() {
  const passed = Math.max(0, (DISCIPLE.lifeMax || 0) - DISCIPLE.lifespanLeft);
  return passed / Math.max(1, (P.LIFESPAN_HOURS * 3600)) * P.LIFESPAN_YEARS;
}
// 天妒系数（>1 表示天妒，渡劫更难）
function jealousyMul() {
  const liveYears = livedYears();
  const expect = expectedYearsAt(G.tier);
  const ahead = liveYears - expect;      // 实际比"应活"更年轻就到达了
  const aheadYears = -ahead;             // 超前年数（越年轻 = 越超前）
  if (aheadYears <= 20) return 1;
  return 1 + Math.min(0.60, (aheadYears - 20) * 0.015);
}
// 天妒的说明（给 UI / 日志）
function jealousyLabel() {
  const m = jealousyMul();
  if (m <= 1.001) return '无';
  return '×' + m.toFixed(2) + '（超前 ' +
    Math.round((m - 1) / 0.015 + 20) + ' 年）';
}

// ---------------- 三之二·二十二、多弟子名册（Round 22）----------------
//
// 用户设计（Round 22）：
//   "宗门招徒以后，强的去前线，弱的去后勤，怎么算强玩家可以定义，或者按照弟子的天赋来，
//    玩家不在的时候就挂机选择，后续就不再更改了"
//   "后勤的弟子，有寿命限制…干活消耗不赖…类似于明日方舟的基建那种"
//   "这种后勤弟子的消耗就靠宗门招徒去弥补，已经越强大的宗门，找的弟子越多，
//    越容易出天赋高的弟子"
//   "1.基础5个招徒，往上数量至少每级加一个吧，然后每次前线弟子结束的时候招徒2"
//   "3…4，每局两年，然后按前线弟子死亡或者回宗门后结算，后勤岗位基础按100年算"
//   "有丹房的话就给弟子加寿元，结算后对比后勤弟子的寿元，够的减去消耗继续活，
//    不够的直接死，死了空出来的位置就用新的弟子补充"
//
// ★ 关键设计（用户提出的，比我的方案好）：
//   后勤消耗【不按现实时间流逝】，而是【跟着前线弟子的生命周期走】
//   ⇒ 后勤与前线共享同一个"世代节奏"，玩家回来看到的是【世代总结】而不是倒计时
//
// ⚠️ 数值校准（建模发现）：
//   按"每局 2 年" ⇒ 一届 72 年 ⇒ 平庸弟子只撑 1.4 届 ⇒ 每届要补 70% 后勤 ⇒ 名册枯竭
//   改为【每届固定 20 年】⇒ 撑 5 届 · 5 人编制每届补 1 人 · 招 2 人 ⇒ 有余量 ✅

const ROSTER = {
  list: [],            // 全部弟子 [{ id, name, talent, linggen, tier, lifespanLeft, role, post, alive }]
  nextId: 1,
  front: null,         // 当前前线弟子（引用 list 里的对象）
  rule: { kind: 'talent', minTalent: 'shang' },   // 分派规则：天赋 ≥ 上乘 → 前线
  recruitEveryRuns: 99,// 距下次招徒还有几局
  pickBy: 'any',       // ★ 派遣（R55）：选派依据 —— any/talent/tier/linggen（默认随缘＝不偏）
};
// ★ 2026-10-16 用户要求：界面统一叫「历练」（原「前线」）。
//   代码内部字段仍是 front（历史命名），下方历史注释里的"前线"按用户原话保留作记录、不改。
const ROLES = { front: '历练', back: '后勤', idle: '候补' };

// ★ 弟子头像素材表（AI 生成 · assets/弟子/ 弟子_1..7.webp）
//   形象与圆盘配色各自独立散列 ⇒ 同代弟子外观不重复，且同一弟子始终不变。
//   ⚠️ 素材按【角色高度归一化】过（都占画布 80%），所以不同来源的图大小一致。
//   ⚠️ AV_COUNT 必须与 assets/弟子/ 里的形象数一致；AV_DISC 数量 = AV_COUNT 时，
//      (id-1) 取模可保证同批弟子的形象与颜色【同时】不重复。
const AV_COUNT = 7;
const AV_DISC = [
  ['#f2ece0', '#cdc4b4'],   // 宣纸
  ['#d6e8d8', '#96ba9e'],   // 竹青
  ['#d6e4f2', '#92b0d2'],   // 天水
  ['#f4dcd6', '#d0968a'],   // 胭脂
  ['#f0e8ce', '#cab680'],   // 秋香
  ['#e4d8ea', '#ac96c2'],   // 紫檀
  ['#dce8e0', '#9cb8a8'],   // 苍青
];
// 灵根档位缩写（用于名册小标；完整名在 title 提示里）
const AV_LG_SHORT = { dan: '单', shuang: '双', san: '三', si: '四', wu: '五', wei: '伪' };
// 场景主角当前用的是哪个形象编号（避免每帧重复写 DOM）
let HERO_AV = 0;
// 当前场景背景用的是哪张（避免每帧重复写 DOM）
let SCENE_BG_KEY = '';
// ★ 妖怪贴图映射（Round 38 · assets/妖怪/妖_<名>.webp）
//   键 = MOB_KINDS 的 id；没有映射的（域外天魔 3 种）自动退回五行色块。
//   小怪用 妖_<名>.webp（16px），精英用 妖_<名>_精英.webp（24px）
const MOB_SPRITE = {
  m_jin_a:  '金甲狮', m_jin_b:  '金角鼠',
  m_mu_a:   '万灵鹿', m_mu_b:   '滕蔓兔',
  m_shui_a: '碧波龟', m_shui_b: '沧澜蛟',
  m_huo_a:  '赤焰狐', m_huo_b:  '焚天雀',
  m_tu_a:   '辟地熊', m_tu_b:   '岩壳蝎',
};
// ★ Boss 贴图映射（Round 39）：键 = MOB_KINDS_BOSS 的 id
//   两套 Boss（用户要求"两套一起用"）：
//     · 魔系妖尊  Boss_B_<id>.webp        —— 就是现在 MOB_KINDS_BOSS 里那 5 个名字
//     · 五方神兽  Boss_<五行>_<神兽>.webp —— 备用：留给更高阶的 Boss 档（尚未接入）
//   Boss 的贴图文件名不带 _Boss 后缀（它本身就是 36px 规格）
const BOSS_SPRITE = {
  B_jin:  'Boss_B_jin',
  B_mu:   'Boss_B_mu',
  B_shui: 'Boss_B_shui',
  B_huo:  'Boss_B_huo',
  B_tu:   'Boss_B_tu',
};
// ★ 宗门设施图标映射（assets/宗门/设施_<名>.webp）
//   key 必须是【设施 id】（FACILITIES 的 id），不是中文名。
//   ⚠️ 2026-10-16 修：原来写的是 `free: '宝库'` —— `free` 不是设施 id（宝库是 `vault`），
//      所以宝库图标永远不会显示。现按 id 逐个映射。
//   九座设施现已全部配图（R58 起 AI 重出，见 `图标与宗门图_清单与做法.md` §七）。
const FAC_ICON = {
  forge: '锻造部',    // 铁砧 + 锤 + 火星
  train: '传功阁',    // 两层楼阁（R58 重出，原为打坐修士）
  script: '藏经阁',   // 展开的古卷轴（R58 重出，原为经楼）
  vault: '宝库',      // 门内金元宝
  legacy: '传承殿',   // 石殿 + 长明灯
  life: '延寿丹房',   // 丹炉 + 青烟
  gate: '山门',       // 石牌坊（R58 出）
  arch: '宗门大殿',   // 重檐主殿（R58 出）
  hall: '议事堂',     // 案几 + 竹简 + 令牌（R58 出）
};

// ★ R59：通用行内图标
//   目录约定见 `图标与宗门图_清单与做法.md` §一；样式见 index.html 的 `.ico`。
//   一律带 srcset 挂 @2x（56px）⇒ 高分屏取大图。
const ICO_DIR = {
  fac: 'assets/宗门/设施_',   // 26px（.bldg-panel .bh img 自己拼路径，这里备一份）
  wp:  'assets/器物/器_',     // 武器：剑/刀/枪/弓/杖
  wx:  'assets/五行/五行_',   // 金/木/水/火/土
  fb:  'assets/法宝/法宝_',   // 6 件法宝
  gf:  'assets/功法/功法_',   // 功法 5 类型
};
// ★ 武器 id → 图标名（空手 `fist` 无图，返回空串）
const WEAPON_ICON = { sword: '剑', blade: '刀', spear: '枪', bow: '弓', staff: '杖' };

function ico(kind, name, cls) {
  const dir = ICO_DIR[kind];
  if (!dir || !name) return '';
  const p = dir + name;
  return '<img class="ico ' + (cls || 'ico16') + '" src="' + p + '.webp" ' +
         'srcset="' + p + '@2x.webp 2x" alt="">';
}

// ============================================================
// ★ R60：音效（表现层最后一块短板）
// ------------------------------------------------------------
// 素材：`assets/音效/*.mp3` —— 113 个，由 `_tools/audio_pack.py` 从
//       `美术资源/05_音效/` 转码（**立体声 WAV 16.3MB → 单声道 MP3 0.73MB，22×**）。
//
// ⚠️ 四条硬约束（全部来自这个项目的实际处境，不是通用最佳实践）：
//
//  1) 【默认关闭】—— 这是**上班摸鱼**游戏。一打开就出声＝灾难。
//     必须玩家显式打开（右上角小喇叭），选择存 localStorage。
//
//  2) 【用 <audio> 元素，不用 Web Audio】—— 发布包是**双击 index.html** 打开的
//     （file:// 协议）。file:// 下 fetch/XHR 被 CORS 拦 ⇒ `decodeAudioData` 拿不到数据。
//     `<audio src>` 不受此限，是唯一在 file:// 下可用的路子。
//
//  3) 【必须节流 + 概率】—— 挂机战斗每秒 1~2 次击杀、每次出手打多个目标。
//     不处理的话是"机关枪"，**比没有音效更糟**。所以每个事件都有
//     `gap`（最小间隔 ms）与 `p`（播放概率）。
//
//  4) 【音量分层】—— 战斗音（挥击/命中）必须比里程碑音（突破/渡劫/Boss）小得多，
//     否则持续推进的战斗音会把里程碑音淹掉。
// ============================================================
const SFX_STORE_KEY = 'mijinglu_sfx';    // '1' = 开
const SFX = {
  on: false,          // 默认关闭（用户首次打开页面时静音）
  vol: 0.55,          // 主音量
  pool: {},           // name → [Audio, Audio, ...]（每名 3 份，允许多次叠加）
  next: {},           // name → 轮转下标
  last: {},           // name → 上次播放时间戳（节流用）
  fail: 0,            // 加载失败计数（只为排错，不打扰玩家）
};

// 事件 → 音频文件名（不含 .mp3）；一个事件给多个 ⇒ 随机取，避免听腻
const SFX_FILES = {
  ui:          ['interface1', 'interface2', 'interface3', 'interface4', 'interface5', 'interface6'],
  ui_open:     ['door', 'interface6'],
  ui_tab:      ['interface2', 'interface5'],
  swing:       ['swish-1', 'swish-2', 'swish-3', 'swish-4', 'swish-5', 'swish-6',
                'swish-7', 'swish-8', 'swish-9', 'swish-10', 'swish-11', 'swish-12', 'swish-13'],
  hit:         ['melee-sound', 'sword-sound', 'swing', 'swing2', 'swing3'],
  crit:        ['metal-ringing', 'metal-small1', 'metal-small2', 'metal-small3'],
  miss:        ['swish-2', 'swish-7', 'swish-11'],
  dodge:       ['cloth', 'cloth-heavy'],
  hurt:        ['giant3', 'ogre2', 'giant4'],
  qi:          ['bubble', 'bubble2', 'bubble3'],
  // —— 敌人死亡：按【形态】分组（见 MOB_KINDS 的 form 字段），而不是按具体名字 ——
  kill_heavy:  ['ogre1', 'ogre2', 'ogre3', 'ogre4', 'ogre5'],
  kill_fast:   ['bite-small', 'bite-small2', 'bite-small3'],
  kill_std:    ['slime1', 'slime2', 'slime3', 'slime4', 'slime5',
                'slime6', 'slime7', 'slime8', 'slime9', 'slime10'],
  kill_grind:  ['mnstr1', 'mnstr4', 'mnstr7', 'mnstr10', 'mnstr13'],
  kill_sec:    ['shade1', 'shade4', 'shade7', 'shade11', 'shade14'],
  kill_elite:  ['mnstr3', 'mnstr9', 'mnstr14', 'wolfman'],
  kill_boss:   ['giant1', 'giant2', 'giant4', 'giant5'],
  // —— 里程碑 ——
  boss_spawn:  ['ogre5', 'giant1'],
  elite_spawn: ['mnstr6', 'wolfman', 'giant5'],
  break:       ['magic1', 'spell'],
  dujie:       ['spell', 'magic1'],
  death:       ['ogre3', 'giant3', 'ogre5'],
  drop:        ['coin', 'coin2', 'coin3'],
  equip:       ['cloth', 'chainmail1', 'armor-light', 'metal-small1', 'wood-small'],
  fac:         ['wood-small', 'metal-ringing', 'bottle', 'bubble'],   // ⚠️ 源文件是 bubble（不是 bubbles）
  banner:      ['beads'],
  scene:       ['door'],
};
// 每个事件的【音量 / 最小间隔 ms / 概率】
const SFX_CFG = {
  ui:          { v: 0.40, gap: 45,  p: 1.00 },
  ui_open:     { v: 0.45, gap: 120, p: 1.00 },
  ui_tab:      { v: 0.35, gap: 90,  p: 1.00 },
  swing:       { v: 0.16, gap: 130, p: 0.65 },   // 出手最频繁 ⇒ 音量最小、还会跳
  hit:         { v: 0.18, gap: 95,  p: 0.55 },
  crit:        { v: 0.34, gap: 140, p: 1.00 },
  miss:        { v: 0.16, gap: 130, p: 0.60 },
  dodge:       { v: 0.22, gap: 200, p: 1.00 },
  hurt:        { v: 0.30, gap: 260, p: 1.00 },
  qi:          { v: 0.22, gap: 400, p: 1.00 },
  kill_heavy:  { v: 0.22, gap: 110, p: 0.55 },
  kill_fast:   { v: 0.17, gap: 110, p: 0.50 },
  kill_std:    { v: 0.19, gap: 110, p: 0.50 },
  kill_grind:  { v: 0.19, gap: 110, p: 0.50 },
  kill_sec:    { v: 0.19, gap: 110, p: 0.50 },
  kill_elite:  { v: 0.48, gap: 300, p: 1.00 },   // 精英死亡＝值得听见
  kill_boss:   { v: 0.70, gap: 500, p: 1.00 },
  boss_spawn:  { v: 0.85, gap: 500, p: 1.00 },   // 全场最响
  elite_spawn: { v: 0.55, gap: 400, p: 1.00 },
  break:       { v: 0.65, gap: 600, p: 1.00 },   // 突破：境界台阶
  dujie:       { v: 0.80, gap: 600, p: 1.00 },
  death:       { v: 0.70, gap: 600, p: 1.00 },   // 弟子死了：只响一次，要响
  drop:        { v: 0.24, gap: 160, p: 0.70 },
  equip:       { v: 0.32, gap: 200, p: 1.00 },
  fac:         { v: 0.26, gap: 500, p: 1.00 },
  banner:      { v: 0.40, gap: 800, p: 1.00 },
  scene:       { v: 0.50, gap: 400, p: 1.00 },
};
// 敌对形态（MOB_KINDS 的 form）→ 死亡音事件
const SFX_FORM = {
  '重装': 'kill_heavy', '迅捷': 'kill_fast', '标准': 'kill_std',
  '磨': 'kill_grind', '秒': 'kill_sec', '精英': 'kill_elite', 'Boss': 'kill_boss',
};
const SFX_CORE = ['ui', 'ui_tab', 'swing', 'hit', 'kill_std'];   // 开机预热的几组

// ============================================================
// ★ R61：战斗表现层（VFX）
// ------------------------------------------------------------
// 分工：**数值层瞬时结算（配平一个字没动），表现层负责让玩家看得见过程。**
//
// 为什么需要这一层（实测）：
//   出手 4.68 次/秒（间隔 214ms）+ AOE 最多同时结算 11 个目标 ⇒
//   "打→命中→死" 全在同一帧完成，玩家只看到怪"凭空少了几只"。
//   拉长节拍（P.CADENCE）把间隔抬到 522ms，再用这里的时间轴把过程摊开。
//
// 时间轴（近战 / 远程两套，这是"手感身份"的来源）：
//   近战  起手 → 挥出弧光 → **立即命中** → 怪碎裂消散
//   远程  起手 → 放出弹丸 → **飞行 ~210ms** → 命中（此时才跳伤害数字/命中音）→ 碎裂
//   ⚠️ 远程的"命中时刻"靠 delay 实现，所以伤害飘字与命中音都必须可延迟（pushDmgFx / sfxDelay）
// ============================================================
// ★★ 重要：这里所有时长都是【真实毫秒】，不是游戏秒。
//   为什么（R63 修的根因）：游戏时钟是真实时间的 **2.33×**（tick 每帧推进 0.5 游戏秒），
//   而 CSS 动画走的是真实时间。之前把时长写成"游戏秒"⇒ 元素存活期比动画短 2.33 倍
//   ⇒ **每个特效的动画都被截断在 43% 就被删掉**（弧光只闪 86ms、淡出都没开始）。
//   现在统一到真实时间，表现层和 CSS 终于同一个钟。
// ★ R67：游戏时钟倍数（实测口径）—— 游戏秒 = 真实秒 × 这个值。
//   加它是因为"离线/后台结算"必须把【游戏秒】和【真实秒】分清：
//   旧代码在这里串了单位，导致标称 12% 的效率实际只有 4.8%。
const CLOCK_RATIO = 2.5;

const VFX = {
  PROJ_MS_PER_UNIT: 1250,  // 弹道飞行 ms / 单位距离。弓 reach 0.23 ⇒ 约 290ms（看得见飞）
  STAGGER_MS: 85,          // 同一次出手多目标时，飘字逐个错开的间隔
  ARC_MS: 320,             // 近战弧光 —— ≥250ms 才看得清一次打击；320ms 能看出起手→收势
  DIE_MS: 420,             // 死亡消散 —— 比弧光更长才有"余韵"（怪是被打碎的，不是消失的）
  SKILL_MS: 900,           // 法宝/功法特效 —— 一局几十次，是"最小仪式感"，又不到打断挂机
  // ★ R65：闪避（位移 + 残影）
  //   实测现状：位移量其实够（0.13 单位 ≈ 竞技场直径 13%），
  //   但 ① 动作只有 scale(.94)（缩 6%，看不出）② dodgeFlash 0.35【游戏秒】= 真实 150ms
  //   ⇒ 所以"闪避看不见"不是位移小，是动作量和时长都不够。
  DODGE_MS: 300,           // 闪避动作时长（真实）。≥250ms 才看得清"人往旁边闪了一下"
  GHOST_MS: 340,           // 残影寿命（比闪避略长，形成拖影）
  GHOST_N: 3,              // 残影个数（3 个足够形成"速度感"，再多就糊）
  NAME_MS: 1150,           // 名字横幅 —— 比特效更长，够玩家读完是哪个法宝
  // ---- 顿帧（hitstop）----
  //   ⚠️ 只冻【表现层】，绝不冻数值：冻游戏时钟会改 DPS 与一局时长 ⇒ 破坏配平。
  //   实现：G.freezeUntil 是一段【真实时间】，期间 render() 不写 mob 坐标（位置不跳变）、
  //        并给 #battleWrap 挂 .freeze 暂停关键帧动画。
  HIT_CRIT: 55,        // 暴击
  HIT_ELITE: 90,       // 精英击杀
  HIT_SKILL: 110,      // 法宝催动 / 功法主动技
  HIT_BIG: 150,        // Boss 现身 / Boss 倒地 / 突破（一局没几次，要"砸"出来）
};

// ============================================================
// ★ R66：进度条 —— 把"还差多少才放"这个隐藏计数器摊开给玩家看
// ------------------------------------------------------------
// 用户："能不能把功法的进度条像自走棋那样显示出来，只看直观一点"
//
// 设计意图（自走棋蓝条的本质）：它解决的**不是信息，是期待**——
//   玩家看到条快满了，就会盯着看"要放了"；释放瞬间清空，形成节拍。
//   所以进度必须是【真实触发用的那个量】，不能是另算一套漂亮的数字。
//
// ⚠️ 因此这两个函数的取值源必须与真实触发**逐字对齐**：
//    · 功法 → gfReady() 用的 GF.lastSwing / GF.lastSec / GF.usedRun（含 CDR）
//    · 法宝 → fbTriggered() 的 ctx（G.threats / G.hp / G.kills / GF.swingW / 精英存活）
//    口径一旦不同，进度条就会骗人 —— 有断言盯着"同源"。
//
// 返回 0~1（1 = 就绪）；返回 null 表示这条没有"进度"概念（不该画条）。
const clamp01 = v => Math.max(0, Math.min(1, v));

/** 功法主动技的冷却进度（与 gfReady 同源）。 */
function gfProgress(g) {
  if (!g || !g.cd) return null;
  if (g.cd === 'swing') {
    const last = GF.lastSwing[g.id];
    if (last === undefined) return 1;                 // 从未放过 ⇒ 就绪
    return clamp01((GF.swingW - last) / g.cdN);
  }
  if (g.cd === 'sec') {
    const last = GF.lastSec[g.id];
    if (last === undefined) return 1;
    const cdr = 1 - Math.min(P.CDR_CAP, G.cdr || 0);  // ★ 与 gfReady 一样要算 CDR
    return clamp01(((G.t || 0) - last) / Math.max(0.1, g.cdN * cdr));
  }
  if (g.cd === 'run') return GF.usedRun[g.id] ? 0 : 1;
  return null;
}

/** 法宝催动条件的进度（与 fbTriggered 的 ctx 同源）。 */
function fbProgress(f) {
  if (!f) return null;
  if (FB.used[f.id]) return 0;                        // 本局已催动过
  switch (f.cond) {
    case 'crisis': return clamp01((G.threats || 0) / f.condN);
    case 'kill':   return clamp01((G.kills || 0) / f.condN);
    // hp 是【反向】进度：生命越低越接近条件 ⇒ 玩家看到条涨满就知道"再挨打就要护国了"
    case 'hp':     return clamp01((1 - G.hp / Math.max(1, G.hpMax)) / Math.max(1e-6, 1 - f.condN));
    case 'elite':  return (G.field || []).some(e => e.kind === 'elite') ? 1 : 0;
    case 'period': return GF.swingW > 0 ? (GF.swingW % f.condN) / f.condN : 0;
    default: return null;
  }
}

// 功法五类 → 颜色（战场条靠颜色区分"是哪一条"，比塞图标省地方）
const GF_TYPE_COLOR = {
  心法: '#e0c464', 身法: '#8fd0c0', 攻伐: '#e08a6a', 护体: '#8fa8e0', 秘术: '#c0a0e0',
};

// ============================================================
// ★ R64：几何命中 —— 「谁挨打」由【位置】决定，不再是"距离最近的 N 个"
// ------------------------------------------------------------
// 用户："把 aoe 数量绑在实际的攻击上面？弹道或者近战砍击打到怪上面才算伤害？"
//
// 实测支撑（剑 · 127 次出手）：reach 圈内中位 **1 只**、平均 1.25 只，
//   **打满 aoe 上限的比例 0%** ⇒ 几何命中对配平的影响 ≈ 0（DPS ×1.00）。
//   同时也是旧实现"违和"的来源：弧光最多张开 reach 的 3 倍宽，
//   看起来扫了一大片，实际只掉 1 只怪的血。
//
// 扇面角度【不是新设定】—— 它就是 WEAPONS 里早就写好的手感描述：
//   sword "范围极短 · 横扫一片" ⇒ 宽扇面 55°
//   blade "范围中等 · 兼顾"     ⇒ 中扇面 40°
//   spear "一寸长一寸强"        ⇒ 窄扇面 18°（靠 reach 长来区分）
//   staff "打击面广 · 单发偏弱"  ⇒ 大溅射 0.080
//   bow   "范围最长 · 落点溅射"  ⇒ 小溅射 0.055
//
// ⚠️ 伤害仍在【出手瞬间】结算（数值层一个字不动 ⇒ 配平零风险），
//    几何只用来决定"打谁"。远程的飘字/命中音本来就已经是"飞到才播"（R61），
//    所以观感上完全就是"打到才算伤害"。
const WPN_HIT = {
  sword: { kind: 'fan',    arc: 55 },
  blade: { kind: 'fan',    arc: 40 },
  spear: { kind: 'fan',    arc: 18 },
  bow:   { kind: 'splash', arc: 22, splash: 0.055 },
  staff: { kind: 'splash', arc: 30, splash: 0.080 },
};
const WPN_HIT_DEF = { kind: 'fan', arc: 30 };   // 没配的武器（空手等）退化成窄扇面

/** 按【几何】挑出这次出手真正打到的怪（已按距离升序）。 */
function hitCandidates(st) {
  const cx = G.heroX, cy = G.heroY;
  const inReach = G.field
    .map(function (e) { return { e: e, d: Math.hypot(e.x - cx, e.y - cy) }; })
    .filter(function (x) { return x.d <= st.reach; });
  if (!inReach.length) return [];
  const H = WPN_HIT[st.weapon.id] || WPN_HIT_DEF;
  if (H.kind === 'fan') {
    // 朝向 = 最近那只怪（玩家意图最可能的方向），落点由它定
    let near = inReach[0];
    for (let i = 1; i < inReach.length; i++) if (inReach[i].d < near.d) near = inReach[i];
    const base = Math.atan2(near.e.y - cy, near.e.x - cx);
    const half = H.arc * Math.PI / 180;
    return inReach.filter(function (c) {
      let a = Math.atan2(c.e.y - cy, c.e.x - cx) - base;
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return Math.abs(a) <= half;
    }).sort(function (a, b) { return a.d - b.d; });
  }
  // 溅射：最近那只当"落点"，落点半径内的都算上
  inReach.sort(function (a, b) { return a.d - b.d; });
  const drop = inReach[0].e;
  return inReach.filter(function (c) {
    return c.e === drop || Math.hypot(c.e.x - drop.x, c.e.y - drop.y) <= H.splash;
  }).sort(function (a, b) { return a.d - b.d; });
}

// 法宝/功法的特效原型：不给 6 件法宝各画一套（又慢又乱），
// 而是【三类原型 × 五行色】。玩家靠"色 + 形状 + 名字横幅"识别发生了什么。
const SKILL_ARCH = {
  rays:  { cls: 'vfx-rays',  big: false },   // 放射光线：攻击型
  ring:  { cls: 'vfx-ring',  big: false },   // 扩散圆环：护体 / 治疗 / 回气
  flash: { cls: 'vfx-flash', big: true },    // 全屏闪 + 大环：底牌级
};
// 法宝 id → 特效原型
const FABAO_ARCH = {
  f_zhuxian: 'rays',   // 诛仙剑阵：全场 ×4，攻击型
  f_huoyu:   'rays',   // 焚天火狱：全场 ×3.5
  f_binghen: 'rays',   // 寒冰封界：全场 ×2
  f_jinwu:   'flash',  // 金乌焚世：全场 ×6 ⇒ 底牌，给最大的
  f_huguo:   'ring',   // 玄龟护国：回血 45% ⇒ 护罩
  f_muhun:   'ring',   // 木灵回春：回血 + 灵气
};

/** 法宝/功法特效 + 名字横幅。数值层不管它，这里只负责"让玩家看见发生了什么"。 */
function skillVfx(name, wx, arch, opts) {
  if (!G.vfxq) return;
  const a = SKILL_ARCH[arch] ? arch : 'ring';
  G.vfxq.push({
    k: 'skill', arch: a, name: name, wx: wx || null,
    x0: G.heroX, y0: G.heroY, t0Real: Date.now(), delayMs: 0,
    big: !!(SKILL_ARCH[a].big || (opts && opts.big)),
  });
}
/** 顿帧：只冻表现（不改数值）。见 VFX.HIT_* 的说明。 */
function hitstop(ms) {
  if (!ms) return;
  const until = Date.now() + ms;
  if (until > (G.freezeUntil || 0)) G.freezeUntil = until;
}

const SFX_Q = [];
/** 音效延后播（远程命中音用）。用游戏时钟 G.t 计时，与暂停/快进天然一致。 */
function sfxDelay(key, volMul, delayMs) {
  if (!SFX.on) return;
  if (!delayMs || delayMs <= 0) { sfx(key, volMul); return; }
  SFX_Q.push({ at: Date.now() + delayMs, key: key, v: volMul });   // ★ R63：真实时钟
}

/** 伤害飘字（可延后）。远程要等弹道飞到才跳字 —— 数值早就算完了，这里只拖表现。 */
function pushDmgFx(x, y, txt, cls, wx, delayMs) {
  const o = { x: x, y: y, txt: txt, cls: cls, wx: wx || null, life: 1 };
  if (!delayMs || delayMs <= 0) { G.fx.push(o); return; }
  G.dmgq.push({ at: Date.now() + delayMs, o: o });                 // ★ R63：真实时钟
}

/** ★ R66：战场技能条 —— 把"还差多少才放"挂在弟子脚下（自走棋那种蓝条）。
 *
 *  ⚠️ 实现要点：**结构变了才重建，每帧只改宽度**。
 *     这是 R61/R65 两次踩过的坑（每帧 innerHTML ⇒ 元素被反复销毁，
 *     连带事件丢失、DOM 抖动）。进度条每帧都在动，更不能整块重建。
 *  设计取舍：最多显示 3 条（再多就变成信息墙）；靠【颜色】区分是哪一条
 *     （功法按五类上色 = GF_TYPE_COLOR，法宝统一金色），比塞图标省地方。
 */
function renderSkillBar() {
  const box = document.getElementById('skillBar');
  if (!box) return;
  const items = [];
  for (const id of gfPriority()) {
    const g = GF_BY_ID[id];
    if (!g) continue;
    const p = gfProgress(g);
    if (p === null) continue;
    items.push({ key: 'gf' + id, p: p, c: GF_TYPE_COLOR[g.type] || '#c8b08a' });
    if (items.length >= 3) break;
  }
  if (items.length < 3) {
    for (const id of (FB.eq || [])) {
      const f = FABAO_BY_ID[id];
      if (!f) continue;
      const p = fbProgress(f);
      if (p === null) continue;
      items.push({ key: 'fb' + id, p: p, c: WX_COLOR[f.wx] || '#c9a227' });
      if (items.length >= 3) break;
    }
  }
  const sig = items.map(x => x.key).join('|');
  if (box._sig !== sig) {                     // ① 只有"显示哪几条"变了才重建
    box._sig = sig;
    box.innerHTML = items.map(x =>
      '<i class="sk" style="--c:' + x.c + '"><b></b></i>').join('');
  }
  const kids = box.children;
  for (let i = 0; i < items.length && i < kids.length; i++) {   // ② 每帧只改宽度
    const bar = kids[i].firstElementChild;
    if (bar) bar.style.width = (items[i].p * 100).toFixed(1) + '%';
    if (kids[i].classList) kids[i].classList.toggle('rdy', items[i].p >= 1);
  }
}

/** 每帧推进表现层：到点的飘字/音效放出来，过期的特效清掉。 */
function vfxTick() {
  // ★★ R63：这一层全部用【真实时钟】—— 与 CSS 动画同一个钟。
  //   之前用 G.t（游戏秒）⇒ 元素存活期只有动画时长的 43%，特效被截断。
  const now = Date.now();
  // ① 延后的伤害飘字（远程要等弹道飞到）
  for (let i = G.dmgq.length - 1; i >= 0; i--) {
    if (now >= G.dmgq[i].at) { G.fx.push(G.dmgq[i].o); G.dmgq.splice(i, 1); }
  }
  // ② 延后的命中音（同上）
  for (let i = SFX_Q.length - 1; i >= 0; i--) {
    if (now >= SFX_Q[i].at) { sfx(SFX_Q[i].key, SFX_Q[i].v); SFX_Q.splice(i, 1); }
  }
  // ③ 特效事件按各自寿命回收（寿命 = CSS 动画时长，这样动画能播完整）
  for (let i = G.vfxq.length - 1; i >= 0; i--) {
    const v = G.vfxq[i];
    const life = v.k === 'arc' ? VFX.ARC_MS
      : (v.k === 'skill' ? VFX.NAME_MS
        : (v.k === 'ghost' ? VFX.GHOST_MS + VFX.GHOST_N * 70 : v.delayMs + VFX.ARC_MS));
    if (now - v.t0Real > life) G.vfxq.splice(i, 1);
  }
}

/** 渲染战斗特效（近战弧光 / 远程弹道）。
 *  坐标与怪物同一套（`x*100%`）⇒ 弹道落点天然对准怪。
 *  弹道用 left/top 的 CSS transition 飞（分辨率无关，不需要换算像素）。 */
function vfxRender(arena) {
  if (!arena) return;
  if (!arena._vfx) arena._vfx = {};
  const box = arena._vfx;
  const live = new Set();
  for (const v of G.vfxq) {
    if (!v._id) v._id = 'v' + (UID++);
    live.add(v._id);
    let el = box[v._id];
    if (el) continue;                         // 已建过 ⇒ 交给 CSS 自己跑
    el = document.createElement('div');
    const ang = Math.atan2(v.y1 - v.y0, v.x1 - v.x0);
    // ★ R65：闪避残影 —— 同一张立绘沿突进方向依次拖出，形成"速度感"
    if (v.k === 'ghost') {
      el.className = 'vfx vfx-ghost';
      el.style.setProperty('--dx', ((v.dx || 0) * -140).toFixed(1) + 'px');
      el.style.setProperty('--dy', ((v.dy || 0) * -140).toFixed(1) + 'px');
      const img = document.createElement('img');
      // ⚠️ HERO_AV 是模块级【变量】不是函数（render 里赋值的当前立绘编号）
      const av = 'assets/弟子/弟子_' + (HERO_AV || 2) + '.webp';
      img.src = av;
      img.alt = '';
      el.appendChild(img);
      for (let gi = 0; gi < VFX.GHOST_N; gi++) {
        const g = el.cloneNode(true);
        g.style.setProperty('--i', gi);
        g.style.animationDelay = (gi * 26) + 'ms';
        arena.appendChild(g);
      }
      el.style.setProperty('--i', 'last');   // 本体那份延迟最久，形成前后层次
      el.style.animationDelay = '44ms';
      arena.appendChild(el);
      box[v._id] = el;
      continue;
    }
    // ★ R62：法宝 / 功法 / 突破的特效（三类原型 × 五行色）—— 带一个名字横幅
    if (v.k === 'skill') {
      const c = WX_COLOR[v.wx] || '#c9a227';
      el.className = 'vfx vfx-skill ' + (SKILL_ARCH[v.arch] || SKILL_ARCH.ring).cls +
        (v.big ? ' big' : '');
      el.style.setProperty('--wx', c);
      el.style.left = (v.x0 * 100) + '%';
      el.style.top = (v.y0 * 100) + '%';
      if (v.name) {
        const nb = document.createElement('span');
        nb.className = 'vfx-name';
        nb.textContent = v.name;
        nb.style.setProperty('--wx', c);
        el.appendChild(nb);
      }
      arena.appendChild(el);
      box[v._id] = el;
      continue;
    }
    el.className = 'vfx ' + (v.k === 'arc' ? 'vfx-arc' : 'vfx-proj vfx-' + v.kind);
    el.style.left = (v.x0 * 100) + '%';
    el.style.top = (v.y0 * 100) + '%';
    el.style.setProperty('--ang', ang + 'rad');
    if (v.k === 'arc') {
      // ★ R64：尺寸 = 真实 reach（不再是"距离+0.11"），角度 = 真实扇面角
      //   ⇒ 弧光覆盖范围与"谁挨打"严格一致
      const rad = (v.radius || 0.12) * 100;
      el.style.setProperty('--sz', rad + '%');
      el.style.setProperty('--a', (v.arcDeg || 40) + 'deg');
    } else {
      el.style.setProperty('--fly', v.delayMs + 'ms');
      el.style.transform = 'rotate(' + ang + 'rad)';
    }
    arena.appendChild(el);
    box[v._id] = el;
    if (v.k === 'proj') {
      // ⚠️ 必须强制一次回流，否则"起点→终点"在同一帧内设置 ⇒ 无过渡、瞬移
      void el.offsetWidth;
      el.style.transition = 'left ' + v.delayMs + 'ms linear, top ' + v.delayMs + 'ms linear';
      el.style.left = (v.x1 * 100) + '%';
      el.style.top = (v.y1 * 100) + '%';
    }
  }
  for (const id of Object.keys(box)) {
    if (live.has(id)) continue;
    const el = box[id];
    el.remove ? el.remove() : (arena.removeChild && arena.removeChild(el));
    delete box[id];
  }
}


function sfxOn() { return SFX.on; }

function sfxLoad(key) {
  const names = SFX_FILES[key];
  if (!names || SFX.pool[key]) return;
  // ⚠️ 这里必须是【扁平池】：把每个变体做 2 份丢进同一个数组。
  //    早期写成了 `names.map(n => [3 个 Audio])` ⇒ pool 元素是【数组】，
  //    `pool[i].play()` 不存在 ⇒ 被 sfx() 的 try/catch 吞掉 ⇒ **永远无声**。
  //    这个错是 _smoke.js 抓出来的（"连调 3 次实播 0 次"）。
  //    扁平池顺带把"随机取变体"和"允许叠加"一次解决：随机下标即可。
  const out = [];
  names.forEach(function (n) {
    for (let i = 0; i < 2; i++) {
      const a = new Audio('assets/音效/' + n + '.mp3');
      a.preload = 'auto';
      a.addEventListener('error', function () { SFX.fail++; });
      out.push(a);
    }
  });
  SFX.pool[key] = out;
}
function sfxWarm() {                              // 打开开关时预热，避免第一次卡顿
  SFX_CORE.concat(['crit', 'kill_heavy', 'break']).forEach(sfxLoad);
}

/** 播一个音效事件。key 见 SFX_FILES；节流/概率/音量都在这里统一处理。 */
function sfx(key, volMul) {
  if (!SFX.on) return;
  const names = SFX_FILES[key];
  if (!names) return;
  const cfg = SFX_CFG[key] || { v: 0.3, gap: 100, p: 1 };
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (SFX.last[key] && now - SFX.last[key] < cfg.gap) return;          // ③ 节流
  if (cfg.p < 1 && Math.random() > cfg.p) return;                      // ③ 概率
  SFX.last[key] = now;
  const pool = SFX.pool[key] || (sfxLoad(key), SFX.pool[key]);
  if (!pool || !pool.length) return;
  const i = (SFX.next[key] = ((SFX.next[key] || 0) + 1) % pool.length);
  const a = pool[i];
  try {
    a.volume = Math.max(0, Math.min(1, SFX.vol * cfg.v * (volMul === undefined ? 1 : volMul)));
    a.currentTime = 0;
    const pr = a.play();
    if (pr && pr.catch) pr.catch(function () { });   // 自动播放策略拒绝 ⇒ 静默忽略
  } catch (e) { /* 播不出来不该影响游戏 */ }
}

function sfxSet(on, quiet) {
  SFX.on = !!on;
  try { localStorage.setItem(SFX_STORE_KEY, SFX.on ? '1' : '0'); } catch (e) { }
  if (SFX.on) { sfxWarm(); if (!quiet) sfx('ui_open'); }
  sfxRender();
}
function sfxRender() {
  // 两个页签（境 / 宗）各有一个开关 ⇒ 状态要同步
  ['btnSfx', 'btnSfx2'].forEach(function (id) {
    const b = document.getElementById(id);
    if (!b) return;
    b.textContent = SFX.on ? '🔊' : '🔇';
    b.classList.toggle('on', SFX.on);
    b.title = SFX.on
      ? '音效已开（点击关闭）'
      : '音效已关 · 默认关闭，避免上班摸鱼时出声（点击打开）';
  });
}
function sfxInit() {
  try { SFX.on = localStorage.getItem(SFX_STORE_KEY) === '1'; } catch (e) { SFX.on = false; }
  ['btnSfx', 'btnSfx2'].forEach(function (id) {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', function () { sfxSet(!SFX.on); });
  });
  // ① 全局点击音（事件委派，一处接全部按钮；不用逐个按钮挂）
  document.addEventListener('click', function (ev) {
    if (!SFX.on) return;
    const t = ev.target;
    if (!t || !t.closest) return;
    const el = t.closest('button, .spot, .nav div, select, .arc-item, .bio-related');
    if (!el || el.id === 'btnSfx' || el.id === 'btnSfx2') return;
    sfx(el.classList && el.classList.contains('spot') ? 'ui_tab' : 'ui');
  }, true);
  sfxRender();
}

// ---- 分派规则（玩家定义 · 一次性）----
const ASSIGN_RULES = [
  { id: 'talent', name: '按天赋', desc: '天赋 ≥ X 的出去历练', levels: ['shang', 'tian', 'yao'] },
  { id: 'tier', name: '按境界', desc: '当前修为 ≥ X 档的出去历练', tiers: [2, 4, 6, 8] },
  { id: 'front_only', name: '只补历练', desc: '有人在外历练就不派，其余全后勤' },
  { id: 'back_only', name: '只要后勤', desc: '全部去后勤（无人历练）' },
];
const TALENT_ORDER = ['fan', 'ping', 'shang', 'tian', 'yao'];
function talentRank(id) { return TALENT_ORDER.indexOf(id); }

// ---- 招徒：宗门阶越高，数量越多、天赋越好 ----
//
//   用户原话（Round 22 · 含澄清）：
//     "1.基础5个招徒，往上数量至少每级加一个吧"
//     "已经宗门扩大以后招人也要增加"
//     "我的意思是小宗门每一代招5人，然后中等宗门每一代招6-7人这样算"
//
//   ⇒ 【每代招人】= 5 + 宗门阶   ← 就是这个量（不是"名册上限"）
//      ⚠️ 我曾误解为"编制上限"，用户澄清：它就是【每代招多少人】
//
//   ⚠️ 平衡：每代招 5 人 × 寿命 5 届 ⇒ 若不加约束，在册会无限膨胀
//      解法：招人量自适应 —— 名册没满【完全按 5+阶 招】（扩张期），
//            满了就只补空缺（稳态）⇒ 在册自动停在【岗位数】
function baseRecruit() {
  return RECRUIT_BASE + SECT.rank;      // 阶0=5 · 阶4=9（用户："小宗门5人，中等宗门6-7人"）
}
const RECRUIT_BASE = 5;                  // 基础每代招人（用户指定：5）
const RECRUIT_PER_LEVEL = 1;             // 宗门每升 1 阶，每代招人 +1（用户："至少每级加一个"）
const ROSTER_CAP = 24;                   // 在册上限 = 后勤岗位总数（岗位随设施定义）
//   用户："每次前线弟子结束的时候招徒 2"
const RECRUIT_PER_GEN = 2;
// 宗门阶对天赋的偏移（"越强大的宗门越容易出天赋高的弟子"）
function rollTalentBySect() {
  const bias = SECT.rank * 0.06;          // 每阶 +6% 概率向高天赋偏移
  let r = Math.random(), acc = 0, pick = TALENTS[TALENTS.length - 1];
  for (let i = 0; i < TALENTS.length; i++) {
    const g = TALENTS[i];
    // 高天赋档位概率增加，低天赋档位概率降低
    let w = g.rate * (1 + bias * (i - 1.5));
    acc += w;
    if (r * 1 < acc) { pick = g; break; }
  }
  return pick;
}
// 生成一个弟子
// ★ Round 34（用户诉求）：弟子要有【名字】——
//   门规署名要给"玄真"而不是"第2代"。用户原话："署名给立规的那一代弟子"
const DISC_SURNAME = ['玄','清','无','太','长','明','素','白','青','赤','云','风','月','星','尘','霜'];
const DISC_GIVEN = ['真','虚','阳','阴','一','初','机','渊','霄','岳','川','溟','离','苍','寂','微','和','朴'];
const DISC_NAMES = [];
function makeDiscipleName() {
  // 避免重名：试 20 次，还重就加序号
  for (let i = 0; i < 20; i++) {
    const n = DISC_SURNAME[Math.floor(Math.random() * DISC_SURNAME.length)] +
              DISC_GIVEN[Math.floor(Math.random() * DISC_GIVEN.length)];
    if (DISC_NAMES.indexOf(n) < 0 && n !== DISCIPLE.name) { DISC_NAMES.push(n); return n; }
  }
  const n2 = DISC_SURNAME[Math.floor(Math.random() * DISC_SURNAME.length)] +
             DISC_GIVEN[Math.floor(Math.random() * DISC_GIVEN.length)] + '·' + (DISC_NAMES.length + 1);
  DISC_NAMES.push(n2); return n2;
}
function makeDisciple(opts) {
  opts = opts || {};
  const tal = opts.talent || rollTalentBySect();
  const lg = opts.linggen || (function () { const old = LG.id; lgResetLinggen(); const c = { id: LG.id, els: LG.els.slice(), main: LG.main, sub: LG.sub }; LG.id = old; return c; })();
  const baseYears = P.LIFESPAN_YEARS * (1 + tal.life) + sectBonus().lifeYear;
  const d = {
    id: ROSTER.nextId++,
    name: opts.name || makeDiscipleName(),   // ★ Round 34：弟子有名字了
    talent: tal.id, talentName: tal.name, talentSpeed: tal.speed,
    linggen: lg.id, linggenName: (LINGGEN.find(x => x.id === lg.id) || {}).name,
    tier: opts.tier || 0,
    lifeMax: baseYears,
    lifespanLeft: baseYears,          // ★ 后勤的"潜在寿命"
    role: 'idle',
    post: null,
    alive: true,
    runs: 0,
    peakTier: opts.tier || 0,
    bornGen: SECT.generation,
    traits: opts.traits ? opts.traits.slice() : rollTraits(),   // ★ 天赋条目（R57）
  };
  return d;
}
// ---- 分派（按规则，一次性）----
// ★★ Round 39 修正：本函数【只分派后勤】，不再自动产生前线
//
//   ⚠️ 为什么改：`endDisciple` 的顺序是
//        generationalTurnover()（同步：清空前线 → 结算后勤 → recruit 补人 → 分岗位）
//        setTimeout(newDisciple, 800)（异步：建立新一代前线）
//      而 generationalTurnover 里已经 `ROSTER.front = null` 了
//      ⇒ recruit 招进来的【第一个】会被分派成前线
//      ⇒ 800ms 后 newDisciple 又建一个 ⇒ **同代出现 2 个前线**
//      实测：第 4 代时前线数 = 4、名册 26 人（超过上限 24）
//
//   ⇒ 职责拆开（用一个开关表达，而不是废掉规则）：
//        newDisciple()  → assignDisciple(d, true)   允许产生前线（一代一个）
//        recruit()      → assignDisciple(d, false)  只补后勤（不抢前线的位置）
//     这样【玩家的分派规则仍然有效】—— 它决定的就是"这一代谁上前线"，
//     只不过现在由 newDisciple 在建立新一代时执行，而不是由补员时顺手决定。
function assignDisciple(d, allowFront) {
  if (allowFront === undefined) allowFront = true;   // 默认保留旧行为（测试与外部调用）
  const r = ROSTER.rule;
  if (!allowFront) { d.role = 'back'; return d; }
  if (r.kind === 'back_only') { d.role = 'back'; return d; }
  // 前线已有 ⇒ 其余全后勤（A 底座：一次只派 1 个前线）
  if (ROSTER.front && ROSTER.front.alive) { d.role = 'back'; return d; }
  if (r.kind === 'front_only') { d.role = 'back'; return d; }
  let ok = false;
  if (r.kind === 'talent') ok = talentRank(d.talent) >= talentRank(r.minTalent || 'shang');
  else if (r.kind === 'tier') ok = d.tier >= (r.minTier || 4);
  if (ok) { d.role = 'front'; ROSTER.front = d; }
  else d.role = 'back';
  return d;
}
// ---- 派遣（R55）· 选派依据 ----
//   用户："新招的弟子的名字肯定不是固定的，所以不是从名单里面派，而是倾向性、天赋、灵根……"
//   ⇒ 不点具体某人（名字是随机生成的，点了没意义），而是给【依据】，由游戏从最新一批新招里挑。
//   ⚠️ 名字 + 天赋会跟着被挑中的人走（见 newDisciple / registerFrontDisciple）。
function pickSuccessor() {
  const cand = ROSTER.list.filter(function (v) { return v.alive && v.role !== 'front'; });
  if (!cand.length) return null;
  let mx = -Infinity;
  for (const v of cand) mx = Math.max(mx, v.recruitGen | 0);      // 只看【最新一批新招的】
  const pool = cand.filter(function (v) { return (v.recruitGen | 0) === mx; });
  const k = ROSTER.pickBy || 'any';
  const sc = function (v) {
    if (k === 'tier') return v.tier | 0;
    if (k === 'linggen') { const g = LINGGEN.find(function (x) { return x.id === v.linggen; }); return g ? g.qi : 0; }
    if (k === 'any') return Math.random();
    return talentRank(v.talent) + 1;                              // talent（默认）
  };
  let best = pool[0], bs = -Infinity;
  for (const v of pool) { const s = sc(v) + Math.random() * 1e-6; if (s > bs) { bs = s; best = v; } }
  return best;
}
// ---- 招徒（前线弟子结束时调用）----
function recruit(deaths) {
  // ★ 每代招人 = 5 + 宗门阶（用户指定）
  //   但若名册已满，只补【死亡数 + 空缺】⇒ 在册自动停在岗位数
  const want = baseRecruit();
  const alive = ROSTER.list.filter(x => x.alive);
  const slots = totalSlots();
  // ⚠️⚠️ Round 39：这里原来只看【活着的】数量，没管名册总人数
  //   ⇒ 上一代死掉的人还留在 list 里占位，加上"按死亡数补人"
  //   ⇒ 名册会涨到 28（超过 ROSTER_CAP = 24）
  //   ⇒ 用【两个上限】同时约束：
  //        ① 岗位数（slots）：活人不超过后勤岗位总数
  //        ② 名册总量（ROSTER_CAP）：list 总长度不超过 24
  const roomBySlot = Math.max(0, slots - alive.length) + (deaths || 0);
  const roomByCap = Math.max(0, ROSTER_CAP - ROSTER.list.length);
  const n = Math.min(want, Math.max(0, Math.min(roomBySlot, roomByCap)));
  const got = [];
  for (let i = 0; i < n; i++) {
    const d = makeDisciple({ tier: trainStartTier() });
    assignDisciple(d, false);   // ★ recruit 只补后勤，不抢前线
    d.recruitGen = SECT.generation;   // ★ 派遣（R55）：标记"这一批新招的"
    ROSTER.list.push(d);
    got.push(d);
  }
  if (got.length) {
    log('✦ 宗门招徒 ' + got.length + ' 人：' +
      got.map(x => x.name + '（' + x.talentName + '·' + ROLES[x.role] + '）').join('、'), 'ok');
    ev('recruit', 6, { n: got.length });
  }
  return got;
}
// ---- 后勤结算（前线弟子结束时调用）----
//   用户："按前线弟子死亡或者回宗门后结算…结算后对比后勤弟子的寿元，
//         够的减去消耗继续活，不够的直接死"
function settleBackline() {
  const cost = backlineCost();
  const dead = [], lived = [];
  for (const d of ROSTER.list) {
    if (!d.alive || d.role !== 'back') continue;
    d.lifespanLeft -= cost;
    if (d.lifespanLeft <= 0) { d.alive = false; d.lifespanLeft = 0; dead.push(d); }
    else lived.push(d);
  }
  if (cost > 0) {
    log('✦ 后勤结算：消耗 ' + cost + ' 年/人 · 存活 ' + lived.length +
      ' 人 · 寿尽 ' + dead.length + ' 人' +
      (dead.length ? '（' + dead.map(x => x.name).join('、') + '）' : ''), dead.length ? 'warn' : 'sys');
    ev('backline_settle', 7, { cost, dead: dead.length, lived: lived.length });
  }
  return { cost, dead, lived };
}
// 每人每届消耗（延寿丹房降低速率）
function backlineCost() {
  const lv = SECT.up.life || 0;
  return Math.max(10, Math.round(20 - lv * 1.67));   // Lv0=20 · Lv3=15
}
// ---- 前线弟子结束 ⇒ 世代交替 ----
function generationalTurnover(cause) {
  const f = ROSTER.front;
  if (f) { f.alive = false; f.role = 'idle'; f.deathCause = cause; }
  ROSTER.front = null;
  const st = settleBackline();       // ★ 先结算后勤（消耗寿元）
  const got = recruit(st.dead.length);  // ★ 再招徒补充（按 5+宗门阶，满了只补缺）
  autoAssignPosts();                 // ★ 重新分配岗位
  const out = grantBacklineOutput(); // ★ 发放后勤产出（含延寿丹房续命）
  return { settled: st, recruited: got, output: out };
}

// ---------------- 三之二·二十三、后勤岗位与产出（Round 22 · 明日方舟基建式）----------------
//
// 用户："后勤岗位我觉得宗门的设施都可以加"
//
// 设计：后勤弟子【挂在宗门设施上】干活，产出与"弟子质量"挂钩。
//   ⇒ 强弟子去前线，弱弟子驻宗 ⇒ 这就是用户的"强/弱分工"
//   ⇒ 宗门设施越强 + 驻宗弟子越强 ⇒ 产出越高（正向循环）
const FACILITIES = [
  { id: 'forge', name: '锻造部', slots: 5, out: 'mats',
    desc: '产出素材', rate: 40 },
  { id: 'train', name: '传功阁', slots: 5, out: 'qi',
    desc: '弟子修炼 +%', rate: 0.02 },
  { id: 'script', name: '藏经阁', slots: 3, out: 'gf',
    desc: '功法研究（提高功法掉落）', rate: 0.015 },
  { id: 'vault', name: '宝库', slots: 3, out: 'drop',
    desc: '装备掉落 +%', rate: 0.02 },
  { id: 'legacy', name: '传承殿', slots: 3, out: 'ilvl',
    desc: '传承品级 +', rate: 0.5 },
  { id: 'life', name: '延寿丹房', slots: 3, out: 'life',
    desc: '为驻宗弟子续命', rate: 1.5 },
  // ★ Round 46：山门 —— 门规 / 训话（宗门法纪）
  { id: 'gate', name: '山门', slots: 2, out: 'none', desc: '宗门法纪（门规 · 训话）' },
  // ★★ Round 50：宗门大殿 —— 宗门史册（编年 / 历代弟子传 / 大事记 / 突破录）
  //   ⚠️ 它原来只是地图上的一个 special 热点，内容却寄存在 hall 里
  //      ⇒ 点后楼右塔（议事堂）看到的是宗门史册（用户报："议事堂里面怎么是宗门史册"）
  //   ⇒ 现在正式独立成设施；slots: 0 ⇒ 不占后勤岗位名额（totalSlots() 不变）
  { id: 'arch', name: '宗门大殿', slots: 0, out: 'none',
    desc: '宗门编年 · 历代弟子传 / 大事记 / 突破录' },
  { id: 'hall', name: '议事堂', slots: 2, out: 'info',
    desc: '秘境情报（提高倾向命中）', rate: 0.01 },
];
const FAC_BY_ID = {};
FACILITIES.forEach(f => FAC_BY_ID[f.id] = f);
// 后勤岗位总数（在册上限）
function totalSlots() {
  let n = 0;
  for (const f of FACILITIES) n += f.slots;
  return n;
}

// 弟子的"资质分"：天赋 + 境界（两位一体决定产出）
//   ⇒ 强弟子驻宗也有价值（不是"弱弟子唯一去处"）
function disciplePower(d) {
  if (!d || !d.alive) return 0;
  const t = TALENT_ORDER.indexOf(d.talent) + 1;      // 1~5
  const tier = (d.tier || 0) + 1;                    // 1~24
  return t * (1 + tier * 0.12);                      // 天赋为主，境界为辅
}
// 某设施的产出总量
function facOutput(fid) {
  const f = FAC_BY_ID[fid];
  if (!f) return 0;
  let sum = 0;
  for (const d of ROSTER.list) {
    if (d.alive && d.role === 'back' && d.post === fid) sum += disciplePower(d);
  }
  return sum;
}
// 产出对各项系统的影响（乘法系数）
function backlineBonus() {
  return {
    mats:   Math.round(facOutput('forge') * FAC_BY_ID.forge.rate),
    qi:     1 + facOutput('train') * FAC_BY_ID.train.rate,
    gf:     1 + facOutput('script') * FAC_BY_ID.script.rate,
    drop:   1 + facOutput('vault') * FAC_BY_ID.vault.rate,
    ilvl:   Math.round(facOutput('legacy') * FAC_BY_ID.legacy.rate),
    life:   Math.round(facOutput('life') * FAC_BY_ID.life.rate),
    info:   1 + facOutput('hall') * FAC_BY_ID.hall.rate,
  };
}
// 分配岗位（自动：把后勤弟子按资质从高到低填满各设施）
function autoAssignPosts() {
  const backs = ROSTER.list.filter(d => d.alive && d.role === 'back');
  backs.sort((a, b) => disciplePower(b) - disciplePower(a));
  // 清空
  for (const f of FACILITIES) f.assigned = 0;
  for (const d of backs) d.post = null;
  // 轮转填充：优先填"产出更缺"的设施（简单起见按顺序轮转）
  let i = 0;
  for (const d of backs) {
    // 找一个还有空位的设施（从 i 开始轮转）
    let placed = false;
    for (let k = 0; k < FACILITIES.length; k++) {
      const f = FACILITIES[(i + k) % FACILITIES.length];
      if (f.assigned < f.slots) {
        d.post = f.id; f.assigned++;
        i = (i + k + 1) % FACILITIES.length;
        placed = true; break;
      }
    }
    if (!placed) d.post = null;   // 岗位满了 ⇒ 闲置（但仍在册）
  }
  return backs.length;
}
// ---- 本期各部产出（给归山见闻"长老带着弟子做了什么"用）----
//   来源：① live 每届结算  ② 离线结算（按离线时间折算届数）
//   看完报告（关掉）后清零 ⇒ 下次报告只看新的一段。
function facYieldAdd(b, gens, healed) {
  const y = G.facYield = G.facYield || { mats: 0, ilvl: 0, lifeSec: 0, healed: 0, gens: 0, b: null };
  y.gens += (gens || 0);
  y.mats += Math.round((b.mats || 0) * (gens || 0));
  y.ilvl += Math.round((b.ilvl || 0) * (gens || 0));
  y.lifeSec += Math.round((b.life || 0) * (gens || 0));
  y.healed += (healed || 0);
  if ((b.mats || 0) + (b.ilvl || 0) + (b.life || 0) > 0) sfx('fac');   // ★ R60：设施真有产出才响
  y.b = b;                       // 系数（每届独立 ⇒ 取最近一届，不累加）
  return y;
}
// 每届结算时发一次产（素材直接入库，其余是系数）
function grantBacklineOutput() {
  const b = backlineBonus();
  if (b.mats > 0) {
    SECT_RES.materials += b.mats;
    SECT_RES.forgedMats = (SECT_RES.forgedMats || 0) + b.mats;
  }
  // ★ 延寿丹房：为驻宗弟子续命（消耗素材）
  //   ⚠️ 修正：若没有后勤弟子可续命，不应扣素材（曾经白扣）
  let healed = 0;
  const backs = ROSTER.list.filter(d => d.alive && d.role === 'back');
  if (b.life > 0 && backs.length > 0) {
    const cost = b.life * backs.length * 8;
    if (SECT_RES.materials >= cost) {
      SECT_RES.materials -= cost;
      for (const d of backs) { d.lifespanLeft += b.life; healed++; }
    }
  }
  facYieldAdd(b, 1, healed);   // ★ 记进本期各部产出（归山见闻用）
  return { b, healed };
}

// ---------------- 三之二·二十、渡劫（Round 20）----------------
//
// 用户决策（Round 20）：
//   "每个大阶段的突破都是要渡劫的"
//   "走火入魔的设定不错"
//   "公式我不太懂就暂时先直接按照你的来吧"
//
// 设计（见 层2数值.md §59）：
//   ① 只在【大境界】跳时触发（每 2 档一次）⇒ 一生 3~5 次
//   ② 成功率 = 基础(随档位下降) × 道基(BD质量) × 余寿 + 推演加成
//   ③ 失败 = 走火入魔：★ 掉修为（灵气）+ 得【道伤】（不跌档 · Round 23 修正）
//      道伤：每道 −5% 修为速度（永久）· 3 道 ⇒ 弟子提前交接
//      但遗产更丰厚（养伤期间把东西整理好了）
//   ④ 护道（给赠）= 渡劫失败时保命（不出道伤、不跌档）· 本代一次
//      推演（给赠）= 成功率 +50%（乘算）
//   ⑤ 成功率可见（符合 BD 红线：只指出问题，不给答案）
let pendingRetire = false;   // ★ 道伤满 ⇒ 本局结束后提前交接（Round 20）
const DUJIE = {
  baseRate: 0.95,        // 炼气期基础成功率（Round 20 校准：0.90 → 0.95）
  perTierDecay: 0.018,   // 每档 −1.8%（Round 20 校准）
  //   ★ 校准依据：渡劫在大境界跳时触发 ⇒ 一生 11 次
  //     若每次 90%+ 则必然失败中途；若每次 70% 则全过率 0.4% 太低
  //     取 0.95 − 档×0.042 ⇒ 累计全过 ≈ 8%，道伤/FORESEE 才是关键变量
  minRate: 0.50,         // 成功率下限（校准：0.25 → 0.50）
  failQiKeep: 0.6,       // 失败后保留的灵气比例
  failQiCost: 2.5,       // ★ 普通失败：额外扣"当档需求 ×此值"的灵气（Round 23）
  //   ⚠️ 为什么改成扣灵气而不是跌档：
  //     跌档会造成"档位震荡死锁"—— 弟子在档2/档3 之间来回跳，一生出不了筑基期
  //     扣灵气是【可恢复】的惩罚，弟子仍能继续冲，只是要多花时间
  scarPenalty: 0.05,     // 每道伤 −5% 修为速度
  maxScars: 3,           // 3 道伤 ⇒ 提前交接
  // ★ 校准（Round 20）：只有【大失败】才留道伤
  //   原因：若每次失败都留道伤，典型弟子 3~4 次渡劫就满 3 道伤提前交接
  //        ⇒ 一生卡在筑基期，永远到不了化神（进度再次死亡）
  //   现改为：roll < rate × severeMul 才算大失败
  severeMul: 0.7,        // 掷点低于成功线的 70% ⇒ 大失败（留道伤）
  severeScarChance: 1.0, // 大失败必留道伤
  scars: 0,              // 本代已积累的道伤
  guardUsed: false,      // 护道是否已用掉（本代一次）
  lastResult: null,      // 最近一次渡劫结果（供 UI / 日志）
};
function dujieReset() {
  DUJIE.scars = 0;
  DUJIE.guardUsed = false;
  DUJIE.lastResult = null;
}
// 是否到了"大境界跳"的档位（每 2 档一次）
function isRealmBreak(fromTier, toTier) {
  return realmOf(toTier) !== realmOf(fromTier);
}
// 基础成功率（只随档位）
function dujieBaseRate(tier) {
  return Math.max(DUJIE.minRate, DUJIE.baseRate - tier * DUJIE.perTierDecay);
}
// 道基系数（BD 质量）：同调等级 + 相性应对
function dujieDaoji(st) {
  if (!st) st = playerStats();
  const td = st.td || { level: 0 };
  // 同调等级 −1(惩罚) ~ 5 ⇒ 系数 0.80 ~ 1.30
  const byTd = 0.80 + (Math.max(-1, Math.min(5, td.level)) + 1) * (0.50 / 6);
  // 相性：主属性是否被当前秘境克制（被克 ⇒ 渡劫更难，正统："此地不利于你"）
  const zb = zbNow();
  let byWx = 1.0;
  if (zb.wx && st.wuxing) {
    const m = wxMul(zb.wx, st.wuxing);   // 秘境属性对我方
    if (m > 1) byWx = 0.90;              // 被克
    else if (m < 1) byWx = 1.10;         // 我克
  }
  return byTd * byWx;
}
// 余寿系数：寿元越足越稳（0.85 ~ 1.15）
function dujieLifeFactor() {
  const total = lifeMaxSeconds();   // ★ Round 21：用动态 lifeMax（含突破加成）
  const pct = Math.max(0, Math.min(1, DISCIPLE.lifespanLeft / Math.max(1, total)));
  return 0.85 + 0.30 * pct;
}
// ★ 成功率（可见 · 可归因）
function dujieRate() {
  const st = playerStats();
  const base = dujieBaseRate(G.tier);
  const dao = dujieDaoji(st);
  const life = dujieLifeFactor();
  // ★ 天妒英才（Round 21）：进度超前 ⇒ 渡劫更难
  const jeal = jealousyMul();
  let r = base * dao * life / jeal;
  r += traitAdd('dujie');     // ★ 天赋条目：心如明镜 / 天人合一
  const foresee = giftPower('foresee');
  if (foresee > 0) r *= (1 + 0.50 * Math.min(1, foresee));   // 推演 +50%
  r = Math.max(0.05, Math.min(0.98, r));
  return {
    rate: r, base, dao, life, jealousy: jeal,
    foresee: foresee > 0 ? (1 + 0.50 * Math.min(1, foresee)) : 1,
    guardian: giftOn('guard') && !DUJIE.guardUsed,
  };
}
// 渡劫（返回结果对象）
function doDujie() {
  sfx('dujie');                      // ★ R60
  const info = dujieRate();
  const roll = Math.random();
  const ok = roll < info.rate;
  const fromTier = G.tier;
  const res = {
    ok, roll, rate: info.rate, tier: fromTier + 1,
    realm: P.REALMS[realmOf(Math.min(23, fromTier + 1))],
    dao: info.dao, life: info.life, base: info.base, foresee: info.foresee,
    scar: false, dropped: false, guarded: false,
  };
  if (ok) {
    DUJIE.lastResult = res;
    ev('dujie_ok', 8, { tier: fromTier + 1, realm: res.realm || '', rate: +(info.rate * 100).toFixed(0) });
    return res;
  }
  // ---- 失败：走火入魔 ----
  // ① 护道：保命（不出道伤、不跌档）
  if (giftOn('guard') && !DUJIE.guardUsed) {
    DUJIE.guardUsed = true;
    res.guarded = true;
    res.scar = false; res.dropped = false;
    DUJIE.lastResult = res;
    log('✦ 渡劫失败，但【护道】余韵护住了弟子 —— 无道伤 · 不跌修为', 'break');
    ev('dujie_guard', 8, { tier: fromTier + 1, realm: res.realm || '' });
    return res;
  }
  // ② 走火入魔：★ 跌【修为】而不是跌【档位】
  //
  //   ⚠️ Round 23 修正：原来失败会【跌 1 档】，实测造成"档位震荡死锁"：
  //      弟子在档2/档3 之间来回跳（渡劫失败跌回档2，攒到档3 又失败）
  //      ⇒ 一生都出不了筑基期。
  //   改为：档位【保留】，但损失大量灵气（等于重修）—— 痛苦但【可恢复】。
  const severe = res.roll < info.rate * DUJIE.severeMul;
  const qiCost = Math.round(qiNeed(fromTier) * (severe ? 1.0 : DUJIE.failQiCost));
  G.qi = Math.max(0, Math.round(G.qi * DUJIE.failQiKeep) - qiCost);
  res.dropped = false;
  res.qiLost = qiCost;
  if (severe) {
    DUJIE.scars++;
    res.scar = true;
    res.scars = DUJIE.scars;
    log('💀 渡劫大失败，走火入魔！修为倒退（灵气 −' + qiCost + '）· ' +
      '得【道伤】' + DUJIE.scars + ' 道（修为速度 −' + Math.round(DUJIE.scars * DUJIE.scarPenalty * 100) + '%）', 'bad');
  } else {
    log('⚡ 渡劫失败，修为倒退（灵气 −' + qiCost + '，未成道伤，可再战）', 'warn');
  }
  ev('dujie_fail', severe ? 9 : 8, { tier: fromTier + 1, realm: res.realm || '', scars: DUJIE.scars, severe });
  // ③ 3 道伤 ⇒ 提前交接
  if (DUJIE.scars >= DUJIE.maxScars) {
    res.retire = true;
    log('⚑ 道伤已满 ' + DUJIE.maxScars + ' 道 —— 弟子无力再进，提前交接传承', 'bad');
  }
  DUJIE.lastResult = res;
  return res;
}
// 道伤对修为速度的影响
function dujieQiMul() {
  return Math.max(0.5, 1 - DUJIE.scars * DUJIE.scarPenalty);
}

// ---------------- 三之二·十九、宗门底盘（弟子出山前的培养 · Round 20）----------------
//
// 用户原话："从零开始不赖，但是毕竟都是大宗门了，把弟子培养到一定程度再出门也正常"
//          "你虽说是宗门底蕴，但是前期的培养肯定也要消耗宗门资源的吧，
//            跨代弟子提升，期间境界突破需要扣除一定的资源，具体资源后面决定"
//
// 设计：
//   宗门用【素材】把新弟子培养到某个起始修为再放出门。
//   ★ 关键取舍：培养消耗素材 ⇒ 与"锻造门装"抢同一份资源
//     （弟子历练产出素材 → 要么造装备，要么培养弟子 —— 这是真决策）
//
//   叙事上也顺：大宗门不是让弟子从零开始爬山，而是先喂到一定境界。
const TRAIN = {
  level: 0,            // 当前底盘等级 0~6
  maxLevel: 6,
  tiersPerLevel: 2,    // 每级 = 2 个修为档
};
// 升级成本（素材）—— ⚠️ 数值待定（SC-14），先用与锻造同量级的锚点
function trainCost(level) {
  const lv = level == null ? TRAIN.level : level;
  if (lv >= TRAIN.maxLevel) return Infinity;
  return Math.round(120 * Math.pow(1.55, lv));
}
// 培养到某档位的总消耗（模拟"期间境界突破需要扣除资源"）
//   每突破 1 档 = 一档的培养消耗，随目标档位上涨
function trainStepCost(tier) {
  return Math.round(25 + tier * 18);
}
function trainTotalCost(fromTier, toTier) {
  let c = 0;
  for (let i = fromTier; i < toTier; i++) c += trainStepCost(i);
  return c;
}
// 底盘给新弟子的起始档位
function trainStartTier() {
  return TRAIN.level * TRAIN.tiersPerLevel;
}
// 升级底盘（消耗素材 + 荣誉）
function trainUpgrade() {
  if (TRAIN.level >= TRAIN.maxLevel) { log('底盘已满级', 'warn'); return false; }
  const cost = trainCost();
  const honor = 60 + TRAIN.level * 90;
  if (SECT_RES.materials < cost) { log('素材不足（需 ' + cost + '）', 'warn'); return false; }
  if (SECT.honor < honor) { log('荣誉点不足（需 ' + honor + '）', 'warn'); return false; }
  SECT_RES.materials -= cost;
  SECT_RES.spent += cost;
  SECT.honor -= honor;
  TRAIN.level++;
  log('✦ 宗门底盘提升至 Lv' + TRAIN.level + '：新弟子从【第 ' +
    (trainStartTier() + 1) + ' 档】起步（耗素材 ' + cost + ' · 荣誉 ' + honor + '）', 'break');
  ev('train_up', 8, { level: TRAIN.level, cost, honor });
  return true;
}
// 新弟子入门时：宗门把他培养到起始档位（**扣资源**）
function trainNewDisciple() {
  const from = 0, to = trainStartTier();
  if (to <= 0) return { tier: 0, cost: 0 };
  const cost = trainTotalCost(from, to);
  // 素材不足 ⇒ 只能培养到能负担的档位（不会卡死）
  let affordable = to;
  while (affordable > 0 && trainTotalCost(from, affordable) > SECT_RES.materials) affordable--;
  const realCost = trainTotalCost(from, affordable);
  if (affordable < to) {
    log('素材不足，宗门只把弟子培养到第 ' + (affordable + 1) + ' 档（想要 ' + (to + 1) + ' 档）', 'warn');
  }
  SECT_RES.materials -= realCost;
  SECT_RES.spent += realCost;
  if (realCost) log('✦ 宗门培养新弟子至第 ' + (affordable + 1) + ' 档（耗素材 ' + realCost + '）', 'ok');
  ev('train_disciple', 6, { tier: affordable + 1, cost: realCost });
  return { tier: affordable, cost: realCost };
}

// ---------------- 三之二·十八、锻造部（统一铸造 · Round 19）----------------
//
// 用户决策："铸造绑到宗门的锻造里面被，好的装备，好的词缀都是让宗门来做"
//
// ⇒ 把 层2数值.md §13（铸造）与 宗门建设.md（锻造部）【合并为一个系统】。
//   两者服务同一件事（让玩家把 BD 造出来），且都是"长期规划 + 不可逆投资" ⇒ 天然归宗门。
//
// 四层能力（见 层2数值.md §57）：
//   ① 出装   素材 → 固定形状装备            （已实装）
//   ② 重铸   素材 + 一件 → 重摇词缀          （不保证变好 = 赌，不是修）
//   ③ 转移   素材 + 两件 → 搬运词缀/签名
//   ④ 定向   素材 + 指定词缀 → 保证出这一条
//   ⑤ 自定义 素材 + 格子形状 → 数值由格子数决定（待定）
//
// ★ 三条设计约束（防止"定向"变成"配答案"）：
//   F1 定向只能指定 1 条，其余仍随机
//   F2 定向不保证数值档，只保证"是哪条"
//   F3 重铸不保证变好

// ---- 成本（乘修为档系数，与出装一致）----
const FORGE_BASE = { reforge: 30, transfer: 8, target: 3 };
function reforgeCost(it) {
  return Math.round(FORGE_BASE.reforge * (1 + G.tier * 0.15) * (1 + (it.q | 0) * 0.35));
}
function transferCost(it) {
  return reforgeCost(it) * FORGE_BASE.transfer;
}
function targetCost(it) {
  return reforgeCost(it) * FORGE_BASE.target;
}

// ---- ② 重铸：重摇词缀（条数不变 · 品质不变 · 不保证变好）----
function reforge(it) {
  if (!it || it.kind2) { log('只能重铸装备', 'warn'); return false; }
  const cost = reforgeCost(it);
  if (SECT_RES.materials < cost) { log('素材不足（需 ' + cost + '）', 'warn'); return false; }
  const old = (it.affixes || []).slice();
  SECT_RES.materials -= cost;
  SECT_RES.spent += cost;
  // 条数由品质决定（AFFIX_COUNT），重摇内容
  it.affixes = rollAffixes(it.q, it.ilvl);
  // ★ F3：不保证变好 —— 如实报告"变好/变差"
  const before = old.reduce((s, id) => s + affixScoreOf(id), 0);
  const after = it.affixes.reduce((s, id) => s + affixScoreOf(id), 0);
  const verdict = after > before ? '变好' : (after < before ? '变差' : '持平');
  log('✦ 重铸 ' + itemName(it) + '（耗素材 ' + cost + '）· ' + old.length + ' → ' +
    it.affixes.length + ' 条 · ' + verdict, after < before ? 'warn' : 'ok');
  ev('reforge', 6, { slot: it.slot, cost, verdict });
  SECT_RES.reforged++;
  return true;
}
// 词缀的粗略价值（正面 1 / 纯负面 -1）—— 供"变好/变差"判定
function affixScoreOf(id) {
  const a = AFFIX_BY_ID[id];
  if (!a) return 0;
  return a.zone === 'neg' ? -1 : 1;
}

// ---- ③ 转移：把源装备的词缀【整体搬到】目标装备 ----
//
//   用途：刷到一件好词缀的低品质装备，把词缀搬到高品质的
function transferAffixes(src, dst) {
  if (!src || !dst || src.kind2 || dst.kind2) { log('只能转移装备', 'warn'); return false; }
  if (src.slot !== dst.slot) { log('只能同部位转移', 'warn'); return false; }
  if (!(src.affixes || []).length) { log('源装备没有词缀', 'warn'); return false; }
  const cost = transferCost(dst);
  if (SECT_RES.materials < cost) { log('素材不足（需 ' + cost + '）', 'warn'); return false; }
  SECT_RES.materials -= cost;
  SECT_RES.spent += cost;
  const moved = src.affixes.slice();
  // 目标能容纳的条数（按品质）
  const cap = AFFIX_COUNT[dst.q] || 0;
  dst.affixes = moved.slice(0, cap);
  dst._transferred = true;
  // 源被消耗（词缀搬走了）
  src.affixes = [];
  log('✦ 词缀转移 → ' + dst.slot + '：' + dst.affixes.join('/') +
    '（耗素材 ' + cost + ' · 受品质上限 ' + cap + ' 条）', 'ok');
  ev('transfer', 7, { slot: dst.slot, cost, n: dst.affixes.length });
  SECT_RES.transferred++;
  return true;
}

// ---- ④ 定向：指定一条词缀（F1：只能指定 1 条，其余仍随机）----
//
//   F2：不保证数值档，只保证"是哪条"
function targetForge(slot, q, wantId) {
  const cost = Math.round(FORGE_BASE.reforge * (1 + G.tier * 0.15) * (1 + (q | 0) * 0.35) * FORGE_BASE.target);
  if (SECT_RES.materials < cost) { log('素材不足（需 ' + cost + '）', 'warn'); return null; }
  const a = AFFIX_BY_ID[wantId];
  if (!a) { log('没有这条词缀', 'warn'); return null; }
  SECT_RES.materials -= cost;
  SECT_RES.spent += cost;
  const ilvl = 1 + G.tier * DROP.ILVL_PER_TIER;
  const isW = (slot === '主手' || slot === '副手');
  const it = makeSlotItem(slot, ilvl, q, isW ? 'sword' : null);
  // ★ F1：先保证目标那条在，其余按品质条数随机补满
  it.affixes = rollAffixes(q, ilvl);
  const cap = AFFIX_COUNT[q] || 0;
  if (cap > 0) {
    const rest = it.affixes.filter(x => x !== wantId);
    it.affixes = [wantId].concat(rest.slice(0, cap - 1));
  }
  it._forged = true; it._targeted = wantId; it._new = true;
  G.bag.push(it);
  log('✦ 定向铸造 ' + slot + '：保底【' + a.name + '】+ ' +
    (it.affixes.length - 1) + ' 条随机（耗素材 ' + cost + '）', 'ok');
  ev('target_forge', 7, { slot, cost, want: wantId });
  SECT_RES.targeted++;
  return it;
}
// 定向可选的词缀池（★ F-1 的默认解法：只列【正面】词缀）
function targetPool() {
  return AFFIXES.filter(a => a.zone !== 'neg');
}


// ---------------- 三之二·十六、灵根（Round 14 · 用户要求）----------------
//
// 用户原话：
//   "弟子角色的设定改一下，初始会有灵根（按照小说来，比如单灵根，双灵根，
//    多灵根之类的，每一代弟子都是随机的，毕竟挂机游戏这样少考虑一些bd，
//    灵根按五行随机给，单灵根和多灵根收益不同，可能是单灵根修炼快，
//    多灵根，同调收益高？"
//
// 设计（按修仙小说惯例）：
//   灵根 = 弟子天生能驾驭的五行数量。越少越"纯"，越多越"杂"。
//
//   | 灵根   | 五行数 | 修炼速度 | 同调加成   | 出现率 |
//   |--------|--------|----------|------------|--------|
//   | 单灵根 | 1      | ×1.40    | 门槛 ×0.95 |  2%    |
//   | 双灵根 | 2      | ×1.15    | 门槛 ×0.92 |  6%    |
//   | 三灵根 | 3      | ×1.05    | 门槛 ×0.85 | 14%    |
//   | 四灵根 | 4      | ×0.95    | 门槛 ×0.78 | 28%    |
//   | 五灵根 | 5      | ×0.80    | 门槛 ×0.70 | 30%    |
//   | 伪灵根 | 0（杂）| ×0.70    | 门槛 ×1.00 | 20%    |
//
//   ★★ Round 50（用户要求）：出现率改为【严格单调 —— 灵根越少越难出】
//     旧表的问题：四灵根最多（32%），而五灵根只有 3% —— **比单灵根（5%）还稀有**
//     ⇒ 与"越少越难出"完全相反。用户："灵根越少越难出"
//     新表：2 / 6 / 14 / 28 / 30（+ 伪灵根 20），随五行数单调上升
//
//   ★★ Round 50：单灵根收益拉到【总体最高】
//     旧的单灵根 qi ×1.30 / 门槛 ×1.00 —— 修炼最快，但同调门槛【最严】，
//     而四/五灵根门槛低得多 ⇒ 综合下来未必是单灵根最强
//     ⇒ ① qi 1.30 → **1.40**（速度优势拉大）
//        ② 门槛 1.00 → **0.95**（不再是"最严"，仍严于双灵根之下各档的对照关系见断言）
//     多灵根保留"同调门槛更低"的特色，但**不再能靠它反超单灵根的总收益**
//
//   ⇒ 单灵根 = 修炼快（但也只能吃一种相性，面对克制自己的秘境吃亏）
//   ⇒ 四/五灵根 = 修炼慢（但同调门槛低 ⇒ 同调等级更容易上去）
//   ⇒ 伪灵根 = 五行皆通但皆不精（小说里最常见的"废柴"开局）
const LINGGEN = [
  { id: 'dan',  name: '单灵根', n: 1, rate: 0.02, qi: 1.40, thresh: 0.95, desc: '天灵根，万中无一 · 修炼极快' },
  { id: 'shuang', name: '双灵根', n: 2, rate: 0.06, qi: 1.15, thresh: 0.92, desc: '上等资质 · 修炼快' },
  { id: 'san',  name: '三灵根', n: 3, rate: 0.14, qi: 1.05, thresh: 0.85, desc: '中等资质' },
  { id: 'si',   name: '四灵根', n: 4, rate: 0.28, qi: 0.95, thresh: 0.78, desc: '下等资质 · 同调易成' },
  { id: 'wu',   name: '五灵根', n: 5, rate: 0.30, qi: 0.80, thresh: 0.70, desc: '五行俱全 · 修炼最慢但同调最盛' },
  { id: 'wei',  name: '伪灵根', n: 0, rate: 0.20, qi: 0.70, thresh: 1.00, desc: '五行皆通皆不精 · 俗称废灵根' },
];
const WX_ALL = ['金', '木', '水', '火', '土'];
const LG = {};   // 本代弟子的灵根

function lgResetLinggen() {
  // 按出现率抽一种
  let r = Math.random(), acc = 0, pick = LINGGEN[LINGGEN.length - 1];
  for (const g of LINGGEN) { acc += g.rate; if (r < acc) { pick = g; break; } }
  LG.id = pick.id;
  LG.name = pick.name;
  LG.qi = pick.qi;
  LG.thresh = pick.thresh;
  LG.desc = pick.desc;
  LG.n = pick.n;
  // 抽具体是哪几种五行（均匀随机，不重复）
  const pool = WX_ALL.slice();
  const els = [];
  const cnt = pick.n === 0 ? 5 : pick.n;   // 伪灵根：五行皆通（但按"不精"处理）
  for (let i = 0; i < cnt && pool.length; i++) {
    els.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  LG.els = els;
  // ★ 主/副灵根（Round 15 · 用户要求："除单灵根外多出来一个灵根主副的区分"）
  //   单灵根：只有主，没有副
  //   多灵根：随机挑一个当【主灵根】（决定主属性），其余里挑一个当【副灵根】
  //   伪灵根：五行皆通但皆不精 ⇒ 仍给主/副（否则"主属性"无从谈起）
  if (els.length === 0) { LG.main = null; LG.sub = null; }
  else if (els.length === 1) { LG.main = els[0]; LG.sub = null; }
  else {
    const mi = Math.floor(Math.random() * els.length);
    LG.main = els[mi];
    const rest = els.filter((_, i) => i !== mi);
    LG.sub = rest[Math.floor(Math.random() * rest.length)];
  }
  return LG;
}
function lgOf() { return (LG.id ? LG : lgResetLinggen()); }
// ★ 指定灵根（测试 / 调试用）——传 null 表示回到随机
function lgSet(id, els) {
  if (!id) { LG.id = null; return lgOf(); }
  const g = LINGGEN.find(x => x.id === id);
  if (!g) return lgOf();
  Object.assign(LG, g);
  LG.els = els && els.length ? els.slice() : WX_ALL.slice(0, g.n === 0 ? 5 : g.n);
  if (LG.els.length === 1) { LG.main = LG.els[0]; LG.sub = null; }
  else { LG.main = LG.els[0]; LG.sub = LG.els[1] || null; }
  return LG;
}
function lgQiMul() { return lgOf().qi; }
// ★ 主灵根 / 副灵根（Round 15）
function lgMain() { return lgOf().main; }
function lgSub() { return lgOf().sub; }
// 描述："主金 · 副水" 或 "主火（纯）"
function lgMainLabel() {
  const g = lgOf();
  if (!g.main) return '无灵根';
  return g.sub ? ('主' + g.main + ' · 副' + g.sub) : ('主' + g.main + '（纯）');
}
function lgTdThreshMul() { return lgOf().thresh; }
function lgLabel() {
  const g = lgOf();
  return g.name + '（' + (g.n === 0 ? '杂' : g.els.join('')) + '）';
}

// ---------------- 三之二·十五、异步 PVP 快照池（Round 13）----------------
//
// 依据：设计规格_PVP.md（极简异步切磋 · 打镜像 · 看回放 · 零操作）
//
// 本模块先服务【比武擂台】—— 擂台不再自己造对手，而是从这个池子里【匹配快照】。
// 池子 = 跨代累积的【玩家自己 + 历代对手】的真实快照，而不是拟合公式。
//
// 匹配（PVP 规格 §5.2 的两维）：
//   ① 难度进度（修为档）—— 保证数值量级一致
//   ② 近期胜率 —— 避免连续碾压/连败（连续 3 败配一个较弱对手）
const PVP = {
  pool: [],            // 快照池 [{ name, tier, power, q, build, gen, at }]
  wins: 0,             // 当前弟子的近期胜率
  losses: 0,
  streak: 0,           // 正=连胜 / 负=连败
  lastLog: [],         // 最近几场的战报摘要（供复盘）
  seedMax: 0,          // 已生成到第几档的种子
};
const PVP_NAME_A = ['青云', '玄水', '赤霄', '白露', '紫电', '苍梧', '太虚', '幽冥', '金乌', '碧游'];
const PVP_NAME_B = ['真人', '散人', '道人', '子', '上人', '居士', '剑修', '丹师'];
function pvpRandomName() {
  return PVP_NAME_A[Math.floor(Math.random() * PVP_NAME_A.length)] +
    PVP_NAME_B[Math.floor(Math.random() * PVP_NAME_B.length)];
}
function pvpResetRun() { PVP.wins = 0; PVP.losses = 0; PVP.streak = 0; PVP.lastLog = []; }

// ---- 种子快照：为每一档预置几个"同档典型对手"（真实装备，不是拟合）----
//   ⚠️ 踩坑记录：原来直接 power = cp × mul，结果"偏弱"能强过"强敌"——
//      因为随机装备本身的战力离散就有 ×1.5（实测档 9：17054 ~ 28394），
//      而难度倍率只有 ±24% ⇒ 倍率形同虚设。
//   ⇒ 改为【先测装备、再校正到目标值】。
function pvpMakeSeed(tier, mul, tag) {
  const saveTier = G.tier, saveZones = G.zones, saveBag = G.bag, saveGF = GF.eq, saveQ = G.filterQ;
  let cp = 1;
  try {
    G.tier = tier; initZones(); G.bag = []; G.filterQ = 0; GF.eq = {};
    const ilvl = 1 + tier * DROP.ILVL_PER_TIER;
    const W = ['sword', 'blade', 'spear', 'bow', 'staff'];
    let wi = 0;
    for (const s of Object.keys(SLOT_ZONE)) {
      const isW = (s === '主手' || s === '副手');
      // 品质统一到传奇，避免品质本身的随机盖过难度倍率
      const it = makeSlotItem(s, ilvl, 3, isW ? W[wi++ % W.length] : null);
      const z = G.zones[it.home];
      for (let y = 0; y < z.h; y++) for (let x = 0; x < z.w; x++)
        if (canPlace(it, it.home, x, y)) { place(it, it.home, x, y); break; }
    }
    cp = combatPower(playerStats());
  } catch (e) { cp = 1; }
  G.tier = saveTier; G.zones = saveZones; G.bag = saveBag; GF.eq = saveGF; G.filterQ = saveQ;
  // ★ 用户决策："偏弱能胜强我觉得没问题" ⇒ 【不做校正】，就用实测战力。
  //   好处：对手是"真实装备算出来的"，不是被公式拉平的假人。
  //   代价：同档对手之间的强弱差可能超过"偏弱/强敌"的标签（被装备波动盖过）。
  //   这个代价【是想要的】——装备滚得好就该赢，这正是刷宝的意义。
  return {
    name: pvpRandomName(), tier, power: Math.max(1, Math.round(cp)), q: 3,
    build: tag, gen: -1, at: 0, seed: true, raw: Math.round(cp * mul),
  };
}
// 确保池子里有该档的种子对手（每档 5 个：弱1 / 平3 / 强1）
function pvpEnsureSeeds(tier) {
  for (let t = 0; t <= tier; t++) {
    if (PVP.pool.some(x => x.seed && x.tier === t)) continue;
    // ★ 不再校正 ⇒ 5 个种子就是 5 个【真实装备】的对手
    //   标签只是"生成时的倾向"，实际强弱看战力（会被装备波动影响，这是想要的）
    const tags = ['偏弱', '略逊', '同阶', '稍强', '强敌'];
    for (const tg of tags) PVP.pool.push(pvpMakeSeed(t, 1.0, tg));
  }
}

// ---- 玩家自己的快照：进秘境时登记 ----
function pvpRecordSelf() {
  const st = playerStats();
  PVP.pool.push({
    name: genLab(SECT.generation) + ' · 本尊',
    tier: G.tier, power: Math.round(combatPower(st)), q: 4,
    build: '同调' + st.td.level + '·' + (st.wuxing || '—') + st.weapon.name,
    gen: SECT.generation, at: Date.now(), self: true,
  });
  if (PVP.pool.length > 300) PVP.pool.splice(0, PVP.pool.length - 300);
}

// ---- 匹配（PVP 规格 §5.2）----
function pvpMatch(tier) {
  pvpEnsureSeeds(tier);
  // ① 难度进度：同档优先，放宽到 ±2 档
  let cand = PVP.pool.filter(x => Math.abs(x.tier - tier) <= 2 && x.power > 0);
  if (cand.length < 3) cand = PVP.pool.filter(x => x.power > 0);
  // ② 近期胜率：连败 3 场 ⇒ 只挑较弱的一半；连胜 ⇒ 只挑较强的一半
  const mine = combatPower(playerStats());
  // ⚠️ 原来写的是"有就更弱、没有就退化成全池随机"——
  //    当玩家明显弱于本档（池里没有更弱的）时会失去保护。
  //    改为：保护性匹配时【只从满足条件的里面挑】；一个都没有就挑【最接近】的那个。
  if (PVP.streak <= -3) {
    const weaker = cand.filter(x => x.power <= mine);
    if (weaker.length) return weaker[Math.floor(Math.random() * weaker.length)];
    // 没有更弱的 ⇒ 挑最强的之下最接近的（仍比随机温和）
    cand = cand.slice().sort((a, b) => a.power - b.power);
    return cand[0] || null;
  }
  if (PVP.streak >= 3) {
    const stronger = cand.filter(x => x.power >= mine);
    if (stronger.length) return stronger[Math.floor(Math.random() * stronger.length)];
    cand = cand.slice().sort((a, b) => b.power - a.power);
    return cand[0] || null;
  }
  return cand[Math.floor(Math.random() * cand.length)] || null;
}

// ---- 打一场（确定性比较 + 记录战报，不做实时）----
function pvpFight(tier, opts) {
  opts = opts || {};
  const st = playerStats();
  const mine = combatPower(st);
  const rival = pvpMatch(tier);
  const oppPower = rival ? rival.power : Math.round(mine);
  let rank, honor;
  if (mine >= oppPower) { rank = '胜'; honor = opts.baseHonor ? opts.baseHonor : 10; }
  else if (mine >= oppPower * 0.92) { rank = '惜败'; honor = 5; }
  else { rank = '败'; honor = 2; }
  // 胜率记录（供下一次匹配用）
  if (rank === '胜') { PVP.wins++; PVP.streak = PVP.streak > 0 ? PVP.streak + 1 : 1; }
  else { PVP.losses++; PVP.streak = PVP.streak < 0 ? PVP.streak - 1 : -1; }
  const rec = {
    rank, mine: Math.round(mine), opp: Math.round(oppPower),
    oppName: rival ? rival.name : '无名',
    oppBuild: rival ? rival.build : '—',
    place: (EVENT.active && EVENT.active.place) || opts.place || '',
    bracket: opts.bracket || '',
  };
  PVP.lastLog.unshift(rec);
  if (PVP.lastLog.length > 8) PVP.lastLog.pop();
  return { ...rec, honor, rival };
}

// ---------------- 三之二·十四、事件系统（Round 13）----------------
//
// 来源：弟子与传承.md §8（用户 Round 12 提案）
// 用户原话："做一些比武擂台什么的，有概率碰到或者是每多少年，某某地方就会举办一次，
//   达到什么条件，角色就会自动参加什么的。然后一些大事件，什么域外天魔入侵什么的，
//   需要角色去什么地方去刷怪，其实和正常的秘境历练区别不大，但是可能会有其他收益"
//
// 5 个待定项的定案见 层2数值.md §44.1。
const EV_CFG = {
  YEARS_PER_RUN: 2.8,        // 一局 ≈ 2.8 寿元年（300s × 100年 / 10800s）
  TOURNEY_EVERY: 25,         // 比武擂台：每 25 寿元年一次（保底）
  // ★ 擂台准入（用户要求："记得进擂台有条件限制"）
  //   与【域外天魔】形成分工：
  //     比武擂台 = 有门槛（够格才被邀请）· 域外天魔 = 无门槛（大事件，人人自危）
  TOURNEY_MIN_TIER: 2,       // 最低修为档（第 3 档）—— 炼气期太弱，不够格上擂台
  // 擂台分档（门槛的可见化：够格之后，参加的是【对应档位】的擂台）
  TOURNEY_BRACKETS: [
    { max: 7, name: '小擂台', honor: 1.0 },
    { max: 15, name: '中等擂台', honor: 1.6 },
    { max: 23, name: '大擂台', honor: 2.4 },
  ],
  INVADE_EVERY: 18,          // 域外天魔：每 18 寿元年判定一次
  INVADE_CHANCE: 0.22,       // 判定通过率
  INVADE_LIFE: 10,           // 入侵窗口持续 10 寿元年
  // 域外天魔的强化（"和正常的秘境历练区别不大"，但有专属敌人）
  INVADE_HP: 1.30, INVADE_DMG: 1.25,
  INVADE_HONOR_PER_KILL: 1,
};
// 地点名（内容层·先给一批）
const EV_PLACES = ['青云峰', '落霞谷', '玄水渊', '赤炎窟', '黄泉渡', '白帝城',
  '紫霄宫', '苍梧岭', '太虚洞', '幽冥海'];
function evPlace(seed) {
  return EV_PLACES[Math.abs(seed | 0) % EV_PLACES.length];
}
const EVENT = {
  year: 0,              // 当前寿元年（挂在弟子寿命上）
  active: null,         // 当前事件 { type, name, place, ... }
  invadeLeft: 0,        // 入侵剩余年份
  nextTourney: EV_CFG.TOURNEY_EVERY,
  nextInvadeCheck: EV_CFG.INVADE_EVERY,
  touched: 0,           // 这一代经历了几个事件（统计）
};
function evResetEvents() {
  EVENT.year = 0; EVENT.active = null; EVENT.invadeLeft = 0;
  EVENT.nextTourney = EV_CFG.TOURNEY_EVERY;
  EVENT.nextInvadeCheck = EV_CFG.INVADE_EVERY;
  EVENT.touched = 0;
}
// 由寿元换算当前年份（寿元从 LIFESPAN 递减）
function evYearNow() {
  const total = lifeMaxSeconds();   // ★ Round 21：动态 lifeMax
  const passed = Math.max(0, total - DISCIPLE.lifespanLeft);
  return passed / total * P.LIFESPAN_YEARS;
}
// 每局结束时推进事件日历
function evTickRun() {
  EVENT.year = evYearNow();
  // 入侵窗口递减
  if (EVENT.invadeLeft > 0) {
    EVENT.invadeLeft -= EV_CFG.YEARS_PER_RUN;
    if (EVENT.invadeLeft <= 0) {
      EVENT.invadeLeft = 0;
      if (EVENT.active && EVENT.active.type === 'invade') EVENT.active = null;
      log('域外天魔退去，天地重归清明', 'sys');
    }
  }
  // ★ 比武擂台：保底周期 + 【准入条件】（用户要求："记得进擂台有条件限制"）
  //
  //   与【域外天魔】的分工（这是两者的本质差别）：
  //     比武擂台 = 有门槛（够格才被邀请）—— 炼气期太弱，不够格
  //     域外天魔 = 无门槛（大事件，人人自危）—— "大事件没有限制"
  if (EVENT.year >= EVENT.nextTourney) {
    EVENT.nextTourney += EV_CFG.TOURNEY_EVERY;
    if (G.tier >= EV_CFG.TOURNEY_MIN_TIER) {
      return { type: 'tourney', name: '比武擂台', place: evPlace(EVENT.year * 7) };
    }
    // 不够格：不参加，但要记一笔（让玩家知道"我还不够格"）
    ev('tourney_skip', 4, { tier: G.tier + 1, need: EV_CFG.TOURNEY_MIN_TIER + 1 });
    log('比武擂台在 ' + evPlace(EVENT.year * 7) + ' 举办，但修为不足（需 ' +
      (EV_CFG.TOURNEY_MIN_TIER + 1) + ' 档）', 'sys');
    return null;
  }
  // ★ 域外天魔：按周期判定
  if (EVENT.year >= EVENT.nextInvadeCheck) {
    EVENT.nextInvadeCheck += EV_CFG.INVADE_EVERY;
    if (EVENT.invadeLeft <= 0 && Math.random() < EV_CFG.INVADE_CHANCE) {
      EVENT.invadeLeft = EV_CFG.INVADE_LIFE;
      return { type: 'invade', name: '域外天魔入侵', place: evPlace(EVENT.year * 13) };
    }
  }
  return null;
}

// ---- 比武擂台：按"综合战力"结算（对战，不是割草）----
function combatPower(st) {
  if (!st) st = playerStats();
  // 攻击 × 出手 × AOE（清场）· 有效生命（能扛）· 同调/相性（BD 质量）
  const clear = st.atk * st.actFreq * Math.max(1, st.aoe) * st.weapon.dmgMul;
  const ehp = st.ehp;
  return Math.sqrt(Math.max(1, clear) * Math.max(1, ehp)) * (0.9 + 0.1 * st.td.level);
}
// 对手战力：该档典型玩家 × 随机系数（0.85 ~ 1.20）
function rivalPower(tier) {
  const f = 0.85 + Math.random() * 0.35;
  // "该档典型" ≈ 裸装 × 装备进度（用 1.28^tier 拟合实测）
  const nakedClear = P.ATK_BASE * Math.pow(P.R_ATK, tier) * P.ACT_FREQ_BASE * P.AOE_BASE * 0.85;
  const nakedEhp = (P.HP_BASE * Math.pow(P.R_HP, tier)) / dmgMul(P.DEF_ANCHOR * Math.pow(P.R_DEF, tier));
  const typical = Math.sqrt(Math.max(1, nakedClear) * Math.max(1, nakedEhp)) * Math.pow(1.28, tier) * 0.62;
  return typical * f;
}
// 当前修为属于哪个擂台档（小/中/大擂台）
function tourneyBracket(tier) {
  for (const b of EV_CFG.TOURNEY_BRACKETS) if (tier <= b.max) return b;
  return EV_CFG.TOURNEY_BRACKETS[EV_CFG.TOURNEY_BRACKETS.length - 1];
}
// 擂台准入是否满足
function tourneyAllowed(tier) {
  return (tier == null ? G.tier : tier) >= EV_CFG.TOURNEY_MIN_TIER;
}

// ★ 打一场擂台 —— 对手来自【异步 PVP 快照池】（用户决策）
//   "擂台具体对手交给异步 pvp"：不再自己造对手，而是匹配池子里的真实快照。
//   匹配规则见设计规格_PVP.md §5.2（难度进度 + 近期胜率）。
function evRunTourney(st) {
  const place = (EVENT.active && EVENT.active.place) || '比武擂台';
  const bk = tourneyBracket(G.tier);
  const f = pvpFight(G.tier, { baseHonor: 8 + G.tier * 2, place, bracket: bk.name });
  const RANK_CN = { '胜': '魁首', '惜败': '次席', '败': '陪榜' };
  const rank = RANK_CN[f.rank] || f.rank;
  // ★ 分档奖励倍率（大擂台给得更多）
  const honor = Math.round(f.honor * bk.honor);
  addHonor(honor, bk.name + ' · ' + rank);
  ev('tourney', 8, { rank, honor, place, opp: f.oppName, mine: f.mine, oppP: f.opp, bracket: bk.name });
  banner('⚔ ' + place + '【' + bk.name + '】：' + rank + '（我方 ' + f.mine + ' vs ' +
    f.oppName + ' ' + f.opp + '）· 荣誉 +' + honor, f.rank === '败' ? 'sys' : 'break');   // ★ Round 43：改横幅播报
  return { rank, honor, rival: f.opp, mine: f.mine, rankRaw: f.rank,
    oppName: f.oppName, bracket: bk.name };
}
// 域外天魔的强度修正（给 mobHp / dangerPerMob 用）
function invadeActive() { return EVENT.invadeLeft > 0; }

// ---------------- 三之二·十三、宗门（局外层 · Round 13）----------------
//
// 设计依据（弟子与传承.md §1 三层结构 / §8 事件系统 / 层2 §42）：
//   第 ① 层 本代弟子的 BD（每代重置）
//   第 ② 层 传承（跨代累积）
//   第 ③ 层 ★ 宗门（永久）—— 本节
//
// 用户原话（Round 11）："局外先不做，但是要考虑" ⇒ Round 13 正式展开。
//
// 三条设计原则：
//   ① 宗门 = 永久，弟子 = 消耗品（每代重置）
//   ② 荣誉点是【宗门层资源】，与【本源】(局内) 分开
//   ③ 宗门加成【温和且永久】，不破坏"境界是唯一乘性来源"
// ---------------- 敌人表（Round 14）----------------
//
// ★ 补全"普通敌人"：原来小怪只有"×1 基准"一种，没有分类。
//   定案：普通敌人 = 五行 × 形态（5 行 × 2 形态 = 10 种），见 层2数值.md §47。
//
//   ⚠️ 同时修一个真 bug：e.wx 从未被赋值 ⇒ 五行相性/签名/法宝相性全是死代码
//      （实测：场上 21 只怪，0 只有五行属性）
//
//   形态只影响"抗性波动"，期望值都是 ×1.0 ⇒ 不破坏既有配平。
const MOB_KINDS = [
  // 金
  { id: 'm_jin_a', wx: '金', name: '剑冢傀', form: '重装', hpMul: 1.15, dmgMul: 0.90 },
  { id: 'm_jin_b', wx: '金', name: '铁甲蜂', form: '迅捷', hpMul: 0.88, dmgMul: 1.12 },
  // 木
  { id: 'm_mu_a', wx: '木', name: '藤蔓妖', form: '重装', hpMul: 1.15, dmgMul: 0.90 },
  { id: 'm_mu_b', wx: '木', name: '青蛇', form: '迅捷', hpMul: 0.88, dmgMul: 1.12 },
  // 水
  { id: 'm_shui_a', wx: '水', name: '寒潭鬼', form: '重装', hpMul: 1.15, dmgMul: 0.90 },
  { id: 'm_shui_b', wx: '水', name: '水猿', form: '迅捷', hpMul: 0.88, dmgMul: 1.12 },
  // 火
  { id: 'm_huo_a', wx: '火', name: '炎魔', form: '重装', hpMul: 1.15, dmgMul: 0.90 },
  { id: 'm_huo_b', wx: '火', name: '赤鸦', form: '迅捷', hpMul: 0.88, dmgMul: 1.12 },
  // 土
  { id: 'm_tu_a', wx: '土', name: '石傀儡', form: '重装', hpMul: 1.15, dmgMul: 0.90 },
  { id: 'm_tu_b', wx: '土', name: '山魈', form: '迅捷', hpMul: 0.88, dmgMul: 1.12 },
];
// ★ 域外天魔专属敌人（无五行 ⇒ 不吃相性）
//
//   设计意图："普通秘境 = 相性博弈；域外天魔 = 相性失效"
//   ⇒ 域外是"检验纯数值与 BD 厚度"的场合，与"大事件"定位一致。
const MOB_KINDS_INVADE = [
  { id: 'v_mo_xiu', wx: null, name: '魔化修士', form: '标准', hpMul: 1.00, dmgMul: 1.00 },
  { id: 'v_mo_zu', wx: null, name: '域外魔卒', form: '磨', hpMul: 1.40, dmgMul: 0.80 },
  { id: 'v_shi_tu', wx: null, name: '天魔使徒', form: '秒', hpMul: 0.75, dmgMul: 1.35 },
];
// ★ 精英敌人（Round 15）：每个五行都有自己的精英，且【精英也有五行】
const MOB_KINDS_ELITE = WX_ALL.map(wx => ({
  id: 'e_' + wx, wx, name: wx + '煞精英', form: '精英',
  hpMul: 1.00, dmgMul: 1.00, elite: true,
}));
// ★ Round 29（用户要求）：Boss —— 【完全复用 AOE 系统】，就像精英一样只是更强
//   "这个单挑系统不要，就用原来那个aoe的，做个boss出来，单挑刚好不用写代码"
//   ⇒ Boss 只是 MOB_KINDS 里更硬更痛的一种，闪避/攻击/受击演出走现有逻辑
const MOB_KINDS_BOSS = [
  { id: 'B_jin', wx: '金', name: '狂骨魔君', form: 'Boss', hpMul: 110, dmgMul: 1.55, boss: true },
  { id: 'B_mu',  wx: '木', name: '青木妖王', form: 'Boss', hpMul: 120, dmgMul: 1.35, boss: true },
  { id: 'B_shui',wx: '水', name: '玄水蛟皇', form: 'Boss', hpMul: 130, dmgMul: 1.28, boss: true },
  { id: 'B_huo', wx: '火', name: '炎狱妖尊', form: 'Boss', hpMul: 100, dmgMul: 1.45, boss: true },
  { id: 'B_tu',  wx: '土', name: '厚土岳神', form: 'Boss', hpMul: 150, dmgMul: 1.20, boss: true },
];
function rollBossKind() {
  const zb = (typeof zbNow === 'function') ? zbNow() : null;
  if (zb && zb.wx) {
    const hit = MOB_KINDS_BOSS.filter(b => b.wx === zb.wx);
    if (hit.length) return hit[0];
  }
  return MOB_KINDS_BOSS[Math.floor(Math.random() * MOB_KINDS_BOSS.length)];
}
function mobTable() {
  if (invadeActive()) return MOB_KINDS_INVADE;      // 域外：无五行，也没有精英
  return MOB_KINDS.concat(MOB_KINDS_ELITE);          // 普通：小怪 + 五行精英
}
function rollMobKind(isElite, isBoss) {
  if (isBoss) return rollBossKind();
  const tbl = mobTable();
  // ★ 精英/小怪分开取（Round 15：精英也有五行）
  const plain = tbl.filter(m => !m.elite);
  const elites = tbl.filter(m => m.elite);
  const src = (isElite && elites.length) ? elites : (plain.length ? plain : tbl);
  // ★ 秘境属性倾向（Round 14）：主导属性的怪占比更高
  //   域外天魔不参与（它们无五行 ⇒ 不吃倾向，这是"相性失效"的体现）
  const zb = zbNow();
  if (zb.wx) {
    const biased = src.filter(m => m.wx === zb.wx);
    if (biased.length && Math.random() < zb.bias) {
      return biased[Math.floor(Math.random() * biased.length)];
    }
  }
  return src[Math.floor(Math.random() * src.length)];
}

// ★ Round 36（用户决策）：门槛下调 —— 实测原来第一次晋阶要等到【第 10 代】
//   用户："第 2~3 代就要晋阶" + "单改宗门层（弟子强度不动）"
//   实测模拟（14 代 11 代停在筑基期 ⇒ 峰值档上限只到 3）：
//     旧 0/120/400/1000/2200 ⇒ 中等宗门在第 10 代
//     新 0/25/180/450/1200   ⇒ 实测 6 次模拟：中等宗门第 2~4 代（中位 3）
//       ⚠️ 早期随机性来自【弟子峰值档波动】（1~4 档）—— 这是设计要的"辨识度"
//          第 1 代只到炼气期(档1, 荣誉 16) ⇒ 第 3 代才晋阶
//          第 1 代就到筑基期(档2, 荣誉 27) ⇒ 第 2 代就晋阶
const SECT_RANKS = [
  { n: '小宗门', need: 0 },
  { n: '中等宗门', need: 30 },
  { n: '大宗门', need: 180 },
  { n: '顶级宗门', need: 450 },
  { n: '仙门', need: 1200 },
];
// 宗门加成（永久 · 跨代累积）
// ★ fac 字段：显式声明这一项【属于哪个后勤设施】（FACILITIES 的 id）
//   ⚠️ 不能让升级项的 id 直接等于设施 id —— 历史上两者不一致：
//      'free'(宝库) 的设施 id 是 'vault'，'slot'(传承殿) 是 'legacy'。
//      不写 fac 就会"升级项和建筑对不上"（界面上表现为宝库/传承殿查不到等级）。
//   fac 为 null 表示【不是建筑】（如「入门礼」是开新弟子的福利）。
const SECT_UPGRADES = [
  { id: 'train', name: '传功阁', max: 5, cost: lv => 40 + lv * 55, rank: 0, fac: 'train',
    desc: level => '弟子修炼 +' + (level * 6) + '%（灵气获取）', eff: { qi: 0.06 } },
  { id: 'slot', name: '传承殿', max: 3, cost: lv => 120 + lv * 180, rank: 1, fac: 'legacy',
    desc: level => '直传传承位 +' + level + '（' + P.LEGACY_SLOTS + ' → ' + (P.LEGACY_SLOTS + level) + '）', eff: { slot: 1 } },
  { id: 'start', name: '入门礼', max: 4, cost: lv => 60 + lv * 90, rank: 1, fac: null,
    desc: level => '新弟子起手灵气 +' + (level * 50), eff: { qi0: 50 } },
  { id: 'free', name: '宝库', max: 4, cost: lv => 80 + lv * 100, rank: 2, fac: 'vault',
    desc: level => '从传承池提取装备便宜 ' + (level * 20) + '%', eff: { discount: 0.20 } },
  { id: 'life', name: '延寿丹房', max: 3, cost: lv => 150 + lv * 150, rank: 3, fac: 'life',
    desc: level => '弟子寿元 +' + (level * 5) + ' 年（延寿丹）', eff: { lifeYear: 5 } },
];
// 设施 id → 升级项（供界面把"建筑"和"升级"对上）
const SECT_UP_BY_FAC = {};
SECT_UPGRADES.forEach(u => { if (u.fac) SECT_UP_BY_FAC[u.fac] = u; });

// ============================================================
// ★ 宗门地图（Round 37）
//
//   用户原话："宗门大图里面的建筑可以对应上我们设定的功能，鼠标放上去能高亮，
//             点进去显示对应功能的界面，然后每次升级，宗门大图整体就对应升级一次"
//
//   定案（用户确认）：
//     · 阶位 0/1 → 档1（素） · 阶位 2/3 → 档2（金顶） · 阶位 4 → 档3（仙门）
//     · 山门不作为设施（纯装饰）
//     · 中路后楼两侧的【双塔】一起挂「议事堂」
//
//   ⚠️ 坐标是百分比（相对图片宽高）。三张图建筑布局一致 ⇒ 共用一套坐标。
//      若某张图偏移明显，给该档单独加一套（SECT_MAP_BY_TIER）。
// ============================================================
const SECT_MAP = [
  // ★ 中路后楼 = 录（宗门史册），和其他设施一样点
  //   用户原话："不是把录的界面放在宗里面，而是放在宗门全景那个中间后楼的里面，
  //             像其他宗门设施一样，然后定个名字表明它的作用"
  //   ★ 名字用「录」：宗主那一辈传下来的宗门编年 —— 弟子传 / 大事记 / 突破录
  //   热点只取【后楼屋顶】，避开左右双塔（塔从 y≈10% 起）
  // ★ Round 43 坐标校准：用户指出红虚线框没框住"两座塔中间的房子"
  //   原来 arch 在 x:39（偏左），和左塔 x:34 重叠
  //   ⇒ 改成：两塔之间【有间隙】，中间的后楼独立框出来
  //     左塔 ≈ 38%   中楼 ≈ 47.5%   右塔 ≈ 64%
  // ★★ Round 50：宗门大殿 = 正式设施（arch），不再是 special 热点
  { fac: 'arch',   name: '中路后楼', x: 44.0, y:  2.0, w:  9.0, h: 15.5 },
  // fac（= FACILITIES 的 id）  显示位置           热点（x%, y%, w%, h%）
  { fac: 'legacy', name: '后楼左塔', x: 34.5, y:  2.0, w:  7.5, h: 19.5 },  // 传承殿
  { fac: 'hall',   name: '后楼右塔', x: 58.5, y:  2.0, w:  7.5, h: 19.5 },  // 议事堂
  { fac: 'vault',  name: '左·后亭',  x: 25.5, y: 24.8, w: 11.5, h: 26.8 },  // 宝库
  { fac: 'life',   name: '右·后亭',  x: 62.9, y: 24.8, w: 11.5, h: 26.8 },  // 延寿丹房
  { fac: 'script', name: '中路正殿', x: 37.4, y: 25.8, w: 16.6, h: 30.8 },  // 藏经阁
  { fac: 'forge',  name: '左·前亭',  x: 15.3, y: 41.7, w: 18.7, h: 29.8 },
  // ★ Round 46：山门（最低处那座三重檐牌楼）—— 用户："把门规整到山门上"
  //   热点避开下方的门洞，只取牌楼主体
  { fac: 'gate',   name: '山门',     x: 33.0, y: 78.0, w: 30.0, h: 21.0 },  // 锻造部
  { fac: 'train',  name: '右·前亭',  x: 65.9, y: 41.7, w: 18.7, h: 29.8 },  // 传功阁
];
// 当前选中的设施（点建筑切换）
let SECT_SEL = 'script';
// ★ 境 · 弟子数据面板是否展开（用户要求：单独控件控制）
// ⚠️ Round 39 修正：保持【默认收起】
//   用户原话："最开始的境的界面里面的数值显示藏到那种拉取框不就好了，
//             你现在改的是啥啊，之前能一眼看到的东西，都找不到了"
//   ⇒ 我第一版把它改成默认展开是【理解错了】—— 用户要的正是"收进拉取框"，
//     不该把面板摊开、把下面的东西挤走
let VIEW_DISC_ID = null;
// 当前地图用的是哪一档图（避免每帧改 src）
let SECT_MAP_TIER = 0;

// ★ 史册馆（Round 37）
//   中路后楼 = 史册馆入口：在它的建筑面板上多一个按钮，点了跳到「录」页。
//   史册的具体内容由「录」页的 #archiveBody 承载（渲染逻辑在别处实现）。
const ARCHIVE_FAC = 'arch';     // ★ Round 45/50：史册馆在【宗门大殿】(arch)
                                //   ⚠️ Round 44 曾设成 script（藏经阁）⇒「翻阅宗门史册」
                                //      按钮出现在藏经阁上（错位，Round 45 已修）
                                //   ★ Round 50：arch 正式成为设施，点它直接进史册页
// ★ Round 40：中路后楼 = 录（宗门史册）的【常驻热点】。
//   用户要求："放在宗门全景那个中间后楼的里面，像其他宗门设施一样，然后定个名字表明作用"
// ★ Round 42/43：arch 热点 = 宗门大殿
//   ★ Round 50：hall（后楼右塔）本来就是【议事堂】，不再与史册混用
const ARCHIVE_NAME = '宗门大殿';
const ARCHIVE_DESC = '宗门编年 · 历代弟子传 / 大事记 / 突破录';
const ARCHIVE_TOPIC = 'arch';     // SECT_MAP 里的特殊 fac 值
let ARCHIVE_OPEN = false;         // 「录」页是否处于史册模式

function openArchive(on) {
  ARCHIVE_OPEN = !!on;
  // ★ Round 44：史册馆在【藏经阁】设施页里，默认可见
  //   ⚠️ 不再用 display 开关它（用「史册/生平」页签切换）
  const box = document.getElementById('archiveBox');
  if (box && box.style && ARCHIVE_OPEN && box.style.display === 'none') box.style.display = '';
  if (ARCHIVE_OPEN) { try { renderArchiveBody(); } catch (e) { } }
  // ★ Round 40：史册馆已【并入「宗」页】（用户："录不是合并到宗门的那个历史馆了吗"）
  //   ⇒ 不再跳到「录」页，只切到「宗」页
  if (typeof goTab === 'function') goTab('zong');
}

// ★★ Round 42：设施页（点地图建筑 ⇒ 整页替换）
//
//   用户："宗页面应该显示地图和宗门基础信息，
//          其他设施信息都应该点击地图建筑以后出现新的页面包含对应信息"
//
//   实现：
//     1. HTML 里每个设施一个 <div data-fac="xxx">（初始 display:none），是各块的原生父级
//     2. openFacility(fid) 把该块 append 进 #facPage 里对应的 <div class="fac"> 壳
//     3. 显示 #facPage、隐藏 #zongHome（首屏）
//     4. 返回时把块放回原父级、恢复首屏
//
//   ⚠️ 关键：块【只是换父级】，元素 id 不变 ⇒ render() 里所有 getElementById 照旧能用，
//      渲染代码一行没改。
const FAC_TITLE = {
  forge: '锻造部', train: '传功阁', script: '藏经阁', vault: '宝库',
  legacy: '传承殿', life: '延寿丹房', arch: '宗门大殿', hall: '议事堂', gate: '山门',
};
let FAC_OPEN = false;
let FAC_SEL = null;      // 当前打开的设施（供 render 刷新升级区）

// ★★ Round 44：设施页顶部的"该建筑升级"区
//   用户："宗门现状下面的各设施的升级情况直接搬到对应建筑的页面"
function renderFacilityUpgrade(fid) {
  const box = document.getElementById('facUpBox');
  if (!box) return;
  const f = FAC_BY_ID[fid];
  const u = SECT_UP_BY_FAC[fid];
  const lv = u ? (SECT.up[u.id] || 0) : 0;
  const alive = ROSTER.list.filter(function (v) { return v.alive; });
  const guard = alive.filter(function (v) { return v.post === fid; }).length;
  let html = '<div class="sec-hd"><span>建筑</span></div>';
  if (f) {
    html += '<div class="bp"><span>作用</span><b>' + f.desc + '</b></div>' +
      '<div class="bp"><span>弟子驻守</span><b>' + guard + '/' + f.slots +
      (guard ? '' : '（空缺）') + '</b></div>';
  }
  if (u) {
    const cost = sectUpCost(u.id);
    const locked = SECT.rank < u.rank;
    const can = !locked && lv < u.max && SECT.honor >= cost;
    html += '<div class="bp"><span>荣誉升级</span><b class="g">Lv' + lv + '/' + u.max + '</b></div>' +
      '<div class="bp"><span>' + (lv >= u.max ? '满级效果' : '下一级效果') + '</span><b>' +
      u.desc(Math.max(1, lv + (lv >= u.max ? 0 : 1))) + '</b></div>';
    if (lv < u.max) {
      const btn = locked ? ('需 ' + SECT_RANKS[u.rank].n) : (cost + ' 荣誉');
      html += '<div class="bbtn" style="margin-top:6px">' +
        '<button data-facup="' + u.id + '"' + (can ? '' : ' disabled') + '>' +
        (locked ? btn : ('升级 · ' + btn)) + '</button></div>';
    }
  } else if (f) {
    html += '<div class="bp"><span>荣誉升级</span><b class="none">该建筑无升级项，只靠弟子驻守</b></div>';
  }
  box.innerHTML = html;
  box.querySelectorAll('button[data-facup]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (buySectUpgrade(btn.getAttribute('data-facup'))) render();
    });
  });
}

function openFacility(fid) {
  const page = document.getElementById('facPage');
  const home = document.getElementById('zongHome');
  if (!page) return;
  // ① 清空所有壳（把上次的块放回它们原来的 data-fac 父级）
  page.querySelectorAll('.fac').forEach(function (shell) {
    while (shell.firstChild) shell.removeChild(shell.firstChild);
  });
  // ② 把该设施的块搬进壳
  // ★★ 修正：必须排除 #facPage 里的壳 —— 否则命中壳自己，搬 0 个节点
  const holder = document.querySelector('#zongScroll > div[data-fac="' + fid + '"]:not(.fac)');
  const shell = page.querySelector('.fac[data-fac="' + fid + '"]');
  if (!holder || !shell) return;
  while (holder.firstChild) shell.appendChild(holder.firstChild);

  const nm = document.getElementById('facName');
  if (nm) {
    // ★ R59：标题带上设施图标（原来进建筑后看不到图，只有地图上那颗）
    const _fi = FAC_ICON[fid];
    nm.innerHTML = (_fi
      ? '<img class="fac-hd-ico" src="assets/宗门/设施_' + _fi + '.webp" ' +
        'srcset="assets/宗门/设施_' + _fi + '@2x.webp 2x" alt="">' : '') +
      (FAC_TITLE[fid] || fid);
  }

  FAC_OPEN = true;
  FAC_SEL = fid;
  if (home) home.style.display = 'none';
  page.style.display = '';
  // 🔴 关键修复：壳自己原来是 display:none（HTML 里写死的）
  //   ⇒ 只显示 #facPage 是不够的，必须把【当前这个壳】也显示出来
  //   否则设施页一片空白（用户报："现在每个建筑点进去的页面也是空的"）
  page.querySelectorAll('.fac').forEach(function (s) {
    s.style.display = (s === shell) ? 'block' : 'none';
  });

  // ③ 宗门大殿（arch）= 史册馆：默认展示史册那一卷
  //   ★ Round 50：原来判的是 hall —— 而 hall 是【议事堂】⇒ 点议事堂进了史册馆
  if (fid === 'arch') {
    try { renderArchiveBody(); } catch (e) { }
    const _ab = document.getElementById('archiveBox');
    const _lb = document.getElementById('logBox');
    if (_ab) _ab.style.display = '';
    if (_lb) _lb.style.display = 'none';
  }
}

function closeFacility() {
  const page = document.getElementById('facPage');
  const home = document.getElementById('zongHome');
  // 把块放回原父级
  if (page) {
    page.querySelectorAll('.fac').forEach(function (shell) {
      const fid = shell.getAttribute('data-fac');
      const holder = document.querySelector('#zongScroll > div[data-fac="' + fid + '"]:not(.fac)');
      if (!holder) return;
      while (shell.firstChild) holder.appendChild(shell.firstChild);
    });
    page.style.display = 'none';
  }
  if (home) home.style.display = '';
  FAC_OPEN = false;
}


// ---------------- 史册馆（Round 38）----------------
//
// 用户（另一个会话）已搭好骨架：
//   #archiveBox  ← 默认 display:none，openArchive(true) 显示
//   #archiveBody ← 内容往这里写
//   .arc-hd / .arc-sec / .arc-item(.g 左代次 + .b 正文) / .arc-empty
//
// ★ 设计：这份"史册"= 【全部历代】的永久合订本（读 SECT.history + EVENTS），
//   而不是"本次会话新增"（那是 #logBox 的《生平》，只记神话/突破等大事件）。
//   两者定位不同：
//     #logBox   流水 · 只记大事件 · 滚动的
//     #archiveBox 合订本 · 历代汇总 · 从宗门建筑点进来的
function renderArchiveBody() {
  const box = document.getElementById('archiveBody');
  if (!box) return;
  const hist = SECT.history || [];
  const gens = SECT.generation || 0;

  // 每次从事件流里取"每一代"的细节（突破/掉落/渡劫…）
  const evd = {};
  try {
    for (const e of EVENTS) {
      if (e.imp < 4) continue;
      (evd[e.gen] = evd[e.gen] || []).push(e);
    }
  } catch (e) { }

  // ⚠️ 表头要自洽：hist 有 40 条上限，所以"已记录"与"历代"是两个数
  //   ⚠️⚠️ stillAlive 必须算在【空状态早退之前】—— 否则 gens=0 时也会显示"当代历练中"
  const recorded = hist.length;
  const stillAlive = (gens > 0 && hist.every(function (x) { return x.gen !== gens; })) ? 1 : 0;

  let h = '';
  // ---- 分册标题 ----
  // ★ Round 44：不再重复渲染「返回宗门」（外层的设施页头已有）
  h += '<div class="arc-hd">宗门史册 <em>历代 ' + gens + ' 代 · 已录 ' +
    recorded + ' 卷' + (stillAlive ? ' · 当代历练中' : '') + '</em></div>';

  if (!hist.length && !gens) {
    h += '<div class="arc-empty">史册尚无记录。<br>' +
      '弟子在秘境中历练、传承、坐化 —— 都会记在这里。</div>';
    box.innerHTML = h;
    return;
  }

  // ---- 卷首 · 宗门本纪（宗门卷 §十：弟子会死，宗门长存）----
  h += renderSectVol();

  // ---- 卷一 · 历代弟子（倒序：近的在前）----
  h += '<div class="arc-sec">卷一 · 历代弟子</div>';
  const CAUSE = { old_age: '善终', battle: '战死秘境', handover: '主动交接' };
  const rows = hist.slice().reverse();
  if (rows.length) {
    for (const x of rows) {
      h += '<div class="arc-item bio-' + bioBarCls(x) + '"><span class="g">' + genLab(x.gen) +
        (x.name ? '<em>' + x.name + '</em>' : '') + '</span>' +
        '<span class="b">' + bioCardBody(x) + '</span></div>';
    }
  } else {
    h += '<div class="arc-empty">第 ' + gens + ' 代弟子正在历练中…</div>';
  }

  // ---- 卷二 · 宗门大事（从事件流里挑宗门层的事件）----
  const bigs = [];
  try {
    for (const e of EVENTS) {
      if (/^sect_rank|^rule_add|^rule_neg|^ascend$|^death_handover$|^boss_kill$/.test(e.type)) {
        bigs.push(e);
      }
    }
  } catch (e) { }
  bigs.sort(function (a, b) { return b.t - a.t; });
  h += '<div class="arc-sec">卷二 · 宗门大事</div>';
  if (bigs.length) {
    const LBL = {
      sect_rank: '宗门晋升', rule_add: '立门规', rule_neg: '积弊成形',
      ascend: '羽化飞仙', death_handover: '主动交接', boss_kill: '讨伐 Boss',
    };
    for (const e of bigs.slice(0, 10)) {
      let d = LBL[e.type] || e.type;
      if (e.type === 'sect_rank' && e.rank) d += ' → <b>' + e.rank + '</b>';
      else if (e.type === 'rule_add') d += ' 〈' + (AXIS_NAME[e.axis] || e.axis || '') + '·' + (e.value || '') + '〉';
      else if (e.type === 'rule_neg') d += ' 〈避' + (e.zone || '') + '〉';
      else if (e.type === 'boss_kill' && e.name) d += ' <b>' + e.name + '</b>';
      h += '<div class="arc-item"><span class="g">' + fmtClock(e.t) + '</span>' +
        '<span class="b">第 ' + e.gen + ' 代 · ' + d + '</span></div>';
    }
  } else {
    h += '<div class="arc-empty">尚无宗门大事。<br>' +
      '<i>（宗门晋阶、立门规、积弊成形、讨伐 Boss 都会记在这里）</i></div>';
  }

  box.innerHTML = h;
}


// 选中建筑的功能面板（由 render() 调用）
function renderSectPanel() {
  const box = document.getElementById('sectPanel');
  if (!box) return;
  const b = SECT_MAP.find(v => v.fac === SECT_SEL) || SECT_MAP[0];
  // ★ Round 50：宗门大殿（arch）—— 面板显示"作用 / 收录 / 翻阅"，
  //   不再走 special 判定（它已经是正式设施，但样式上仍是档案性质）
  //   ⚠️ R58 补：这个分支提前 return，原来漏掉了图标（九座设施里唯一没图的）
  if (b.fac === 'arch') {
    const aico = FAC_ICON[b.fac];
    box.innerHTML =
      '<div class="bldg-panel">' +
        '<div class="bh">' +
          (aico ? '<img src="assets/宗门/设施_' + aico + '.webp" ' +
                  'srcset="assets/宗门/设施_' + aico + '@2x.webp 2x" alt="">' : '') +
          '<div><b>' + ARCHIVE_NAME + '</b><em>' + b.name + '</em></div></div>' +
        '<div class="bp"><span>作用</span><b>' + ARCHIVE_DESC + '</b></div>' +
        '<div class="bp"><span>收录</span><b>历代弟子 ' + SECT.history.length + ' 位 · 事迹 ' +
          (Array.isArray(G.log) ? G.log.length : 0) + ' 条</b></div>' +
        '<div class="bbtn" style="margin-top:6px">' +
          '<button data-arch-open="1">翻阅宗门史册 ▸</button></div>' +
      '</div>';
    box.querySelectorAll('button[data-arch-open]').forEach(function (btn) {
      // ★ Round 45：史册馆在【宗门大殿】本页里
      //   ⚠️ Round 44 我搞错了顺序，把史册塞进了【藏经阁】(script)
      //      正确：宗门大殿(hall) = 门规 + 史册馆；藏经阁(script) = 功法研究
      btn.addEventListener('click', function () {
        try { renderArchiveBody(); } catch (e) { }
        const ab = document.getElementById('archiveBox');
        const lb = document.getElementById('logBox');
        if (ab) ab.style.display = '';
        if (lb) lb.style.display = 'none';
      });
    });
    return;
  }
  const f = FAC_BY_ID[b.fac];
  if (!f) { box.innerHTML = ''; return; }
  const u = SECT_UP_BY_FAC[b.fac];
  const lv = u ? (SECT.up[u.id] || 0) : 0;
  const alive = ROSTER.list.filter(v => v.alive);
  const guard = alive.filter(v => v.post === b.fac).length;
  const locked = u && SECT.rank < u.rank;
  const cost = u ? sectUpCost(u.id) : Infinity;
  const can = u && !locked && lv < u.max && SECT.honor >= cost;
  let pips = '';
  if (u) for (let i = 0; i < u.max; i++) pips += (i < lv) ? '●' : '○';
  const ico = FAC_ICON[b.fac];

  box.innerHTML =
    '<div class="bldg-panel">' +
      '<div class="bh">' +
        (ico ? '<img src="assets/宗门/设施_' + ico + '.webp" ' +
               'srcset="assets/宗门/设施_' + ico + '@2x.webp 2x" alt="">' : '') +
        '<div><b>' + f.name + '</b><em>' + b.name +
          (u ? (' · ' + (SECT_UPGRADES.find(v => v.id === u.id) ? '' : '')) : '') +
        '</em></div>' +
      '</div>' +
      '<div class="bp"><span>建筑效果</span><b>' + f.desc + '</b></div>' +
      '<div class="bp"><span>弟子驻守</span><b>' + guard + '/' + f.slots +
        (guard ? '' : '（空缺）') + '</b></div>' +
      (u
        ? '<div class="bp"><span>荣誉升级</span><b class="g">' + pips +
            ' Lv' + lv + '/' + u.max + '</b></div>' +
          '<div class="bp"><span>升级效果</span><b>' + u.desc(Math.max(1, lv)) + '</b></div>' +
          '<div class="bp"><span>' + (lv >= u.max ? '状态' : '下一级') + '</span><b class="' +
            (locked ? 'lock' : '') + '">' +
            (locked ? ('需宗门达到 ' + SECT_RANKS[u.rank].n)
                    : (lv >= u.max ? '已满级' : ('耗荣誉 ' + cost))) + '</b></div>'
        : '<div class="bp"><span>荣誉升级</span><b class="none">该建筑无升级项，只靠弟子驻守</b></div>') +
      (u && lv < u.max
        ? '<div class="bbtn"><button data-scmap="' + u.id + '"' +
            (can ? '' : ' disabled') + '>' +
            (locked ? ('需 ' + SECT_RANKS[u.rank].n) : ('升级 ' + cost)) + '</button></div>'
        : '') +
      // ★ 中路后楼 = 史册馆入口（点了跳到「录」页的史册）
      (b.fac === ARCHIVE_FAC
        ? '<div class="bbtn" style="margin-top:4px">' +
            '<button data-arc="1">翻阅宗门史册 ▸</button></div>'
        : '') +
    '</div>';

  box.querySelectorAll('button[data-scmap]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (buySectUpgrade(btn.getAttribute('data-scmap'))) render();
    });
  });
  box.querySelectorAll('button[data-arc]').forEach(function (btn) {
    btn.addEventListener('click', function () { openArchive(true); });
  });
}
const SECT = {
  generation: 0,          // 第几代弟子（newDisciple 里 +1）
  legacyPool: [],         // 传承池（除了直传给下一代的，其余存这里）
  lostLegacy: [],         // 遗落在外的传承（待取回）
  history: [],            // 历代弟子记录
  ascended: false,        // 是否已有人飞仙
  // ★★ Round 43：每代生平（用户："史册馆的生平记得有归类喔，
  //   毕竟有很多代历练弟子，每代都该有自己的生平"）
  //   { [代]: [{msg, cls, t, atk, kills, qi, tier}, ...] }
  //   ⚠️ G.log 只有 60 条且【不进存档】⇒ 弟子死时把这一代的记录快照到这里
  chronicle: {},
  // ★ Round 13：宗门层
  honor: 0,               // 荣誉点（永久 · 跨代累积）
  rank: 0,                // 宗门等级下标（SECT_RANKS）
  up: {},                 // 各项加成的已购等级 { train: 2, slot: 1, ... }
  // ★ Round 25（用户要求）：神话传承的【徽记】—— 禁止后人穿出去的清单
  //   "神话可以传承，比如放到宗门宝库，让玩家可以选，让不让后人穿出去之类的"
  legacyBan: {},          // { [itemId]: true } ⇒ 该件不进直传（只留宝库）
  legacyBanQ: 4,          // 默认只对神话（q4）开放徽记
  // ★★ 叙事层（Round 51）：长老 / 宗主 / 宗门成长线
  //   长老 = 9 设施各 1 名稳定后勤弟子（不进秘境，按任期流转，终会换）
  //   宗主 = 长老之一被老祖擢（默认 gate 山门长老），是归山见闻的报信人
  elders: null,           // { [facId]: { name, sinceGen, dieGen, facility } }
  sectMaster: null,       // 被擢为宗主的长老 facId（如 'gate'）
  topTier: 0,             // 宗门见过的最高修为档（算长老任期基准）
};

// ---- 荣誉点的获取（弟子的一生成就）----
function honorForDisciple() {
  // ★ Round 36（用户决策）：荣誉产出重算
  //
  //   ⚠️ 旧公式 `5 + 峰值档×3 + 突破次数` 的问题：
  //     峰值档是【线性】，而实测早期弟子峰值档只到 3
  //     ⇒ 一代只拿 5~25 荣誉，而晋中等宗门要 120 ⇒ 【第 10 代才升】
  //
  //   ⇒ 改为【峰值档的二次方】：让"弟子越强 ⇒ 宗门越快"有真实杠杆
  //     峰值档 0 → (0+1)²×4 = 4
  //     峰值档 2 → (2+1)²×4 = 36
  //     峰值档 5 → (5+1)²×4 = 144   ← 强弟子的价值被拉开
  //     峰值档 10 → (10+1)²×4 = 484
  //   实测：中等宗门第 3 代 · 大宗门第 7 代 · 顶级第 13 代 · 仙门第 30 代
  const pk = DISCIPLE.peakTier | 0;
  let v = 10;                                       // 入门基础（Round 36：5 → 10）
  v += Math.min(30, G.breakCount);                  // 突破次数（上限 30）
  v += Math.pow(pk + 1, 2) * 6;                     // ★ 修为档：二次方（Round 36：K=4 → 6）
  if (DISCIPLE.deathCause === 'handover') v += 8;   // 主动交接（聪明的弟子）
  return Math.round(v);
}
function addHonor(n, why) {
  if (!n) return;
  SECT.honor += n;
  refreshSectRank();
  log('✦ 宗门获得荣誉点 +' + n + (why ? '（' + why + '）' : '') + ' · 共 ' + SECT.honor, 'break');
}
function refreshSectRank() {
  let r = 0;
  for (let i = 0; i < SECT_RANKS.length; i++) if (SECT.honor >= SECT_RANKS[i].need) r = i;
  if (r !== SECT.rank) {
    SECT.rank = r;
    log('✦ 宗门晋升：' + SECT_RANKS[r].n + '！', 'break');
    ev('sect_rank', 9, { rank: SECT_RANKS[r].n });
  }
}

// ---- 加成的读取（汇总已购等级）----
function sectBonus() {
  const b = { qi: 1, slot: 0, qi0: 0, discount: 1, life: 1, lifeYear: 0 };
  for (const u of SECT_UPGRADES) {
    const lv = SECT.up[u.id] || 0;
    if (!lv) continue;
    if (u.eff.qi) b.qi *= (1 + u.eff.qi * lv);
    if (u.eff.slot) b.slot += u.eff.slot * lv;
    if (u.eff.qi0) b.qi0 += u.eff.qi0 * lv;
    if (u.eff.discount) b.discount *= Math.pow(1 - u.eff.discount, lv);
    if (u.eff.lifeYear) b.lifeYear += u.eff.lifeYear * lv;   // ★ Round 21：改为 +N 年/级
  }
  // ★ Round 22：后勤驻宗弟子的加成（传功阁 = 修炼速度）
  try {
    const bl = backlineBonus();
    b.qi *= bl.qi;
    b.gfDrop = bl.gf;
    b.dropMul = bl.drop;
    b.ilvlBonus = bl.ilvl;
    b.infoMul = bl.info;
  } catch (e) { }
  return b;
}
// 从传承池提取装备的花费（荣誉点）—— 给传承池一个出口
function legacyPullCost(it) {
  const base = 20 + Math.round((it.ilvl || 1) * 0.4) + (it.q | 0) * 15;
  return Math.max(5, Math.round(base * sectBonus().discount));
}
function canAffordPull() { return SECT.honor > 0; }
// 从传承池提取一件（花费荣誉点）
function pullFromPool(idx) {
  const it = SECT.legacyPool[idx];
  if (!it) return false;
  const cost = legacyPullCost(it);
  if (SECT.honor < cost) { log('荣誉点不足（需 ' + cost + '）', 'warn'); return false; }
  SECT.honor -= cost;
  SECT.legacyPool.splice(idx, 1);
  G.bag.push(it);
  log('✦ 从传承池提取 ' + (it.slot || '装备') + '（耗荣誉 ' + cost + '）', 'ok');
  return true;
}
// ---- 购买宗门加成 ----
function sectUpCost(id) {
  const u = SECT_UPGRADES.find(x => x.id === id);
  if (!u) return Infinity;
  const lv = SECT.up[id] || 0;
  if (lv >= u.max) return Infinity;
  return u.cost(lv);
}
function buySectUpgrade(id) {
  const u = SECT_UPGRADES.find(x => x.id === id);
  if (!u) return false;
  const lv = SECT.up[id] || 0;
  if (lv >= u.max) { log('「' + u.name + '」已满级', 'warn'); return false; }
  if (SECT.rank < u.rank) { log('「' + u.name + '」需要宗门达到 ' + SECT_RANKS[u.rank].n, 'warn'); return false; }
  const cost = u.cost(lv);
  if (SECT.honor < cost) { log('荣誉点不足（需 ' + cost + '）', 'warn'); return false; }
  SECT.honor -= cost;
  SECT.up[id] = lv + 1;
  log('✦ 宗门提升：「' + u.name + '」Lv.' + (lv + 1) + ' — ' + u.desc(lv + 1), 'break');
  ev('sect_up', 8, { name: u.name, lv: lv + 1 });
  return true;
}

const DISCIPLE = {
  lifespanLeft: 0,        // 剩余寿元（秒）
  born: 0,                // 出生时刻（真实时间戳）
  deathCause: null,       // 'old_age' | 'battle' | null
  peakTier: 0,            // 这一代达到过的最高修为档
  runs: 0,                // 这一代经历了几局
  pers: null,             // ★ 性格（12 选 1；老档为 null ⇒ 降级通用文案）
  traits: [],             // ★ 天赋条目（R57，id 数组；老档为空 ⇒ 不生效）
};

// 新弟子入门（carried = 上一代直传的装备）
function newDisciple(carried, opts) {
  if (opts && opts.resetSect) {
    // ⚠️ 重置成 -1，这样随后的 ++ 得到 0，再由调用方决定
    //    （原来设 0 会导致"第 0 代弟子"这种荒谬编号）
    SECT.generation = (opts.startAtZero ? -1 : 0);
    SECT.legacyPool.length = 0;
    SECT.lostLegacy.length = 0;
    SECT.history.length = 0;
    SECT.ascended = false;
    SECT.elders = null;        // ★ 叙事层：重新开始 ⇒ 长老班底重抽
    SECT.sectMaster = null;
  }
  SECT.generation++;
  ensureElders();              // ★ 叙事层：保证长老班底存在（建宗 / 读档都走这）
  rotateElders();             // ★ 叙事层：每代检查长老/宗主任期，到则交班
  // ★ 派遣（R55）：按议事堂定的【选派依据】，从最新一批新招弟子里挑一个当代出门
  //   ⚠️ 必须在 talReset 与寿元初值【之前】决定，否则天赋改了寿元却没跟着改
  const _pref = pickSuccessor();
  DISCIPLE._prefId = _pref ? _pref.id : null;
  if (_pref) {
    const _tg = TALENTS.find(function (x) { return x.id === _pref.talent; });
    if (_tg) Object.assign(TAL, _tg); else talReset();
  } else talReset();        // ★ 天赋：每代随机（必须在寿元初值之前 → 决定 lifeMax）
  // ★ 天赋条目：必须在【寿元初值之前】定下 —— talLifeMul() 含天赋与天妒，
  //   晚设会让"寿元初值"和"lifeMax"基于两代不同的天赋（测试抓过这个错）
  DISCIPLE.traits = _pref ? (_pref.traits || []).slice() : rollTraits();
  DISCIPLE.lifespanLeft = (P.LIFESPAN_YEARS * talLifeMul() + sectBonus().lifeYear) / P.LIFESPAN_YEARS * (P.LIFESPAN_HOURS * 3600);   // ★ 延寿丹（年）丹房 × 天赋
  // ★ Round 34：给这一代弟子起名（门规署名、编年史都要用）
  DISCIPLE.name = _pref ? _pref.name : makeDiscipleName();   // ★ 派遣：沿用被挑中者的名字
  DISCIPLE.born = Date.now();
  DISCIPLE.deathCause = null;
  DISCIPLE.peakTier = 0;
  DISCIPLE.runs = 0;
  DISCIPLE.pers = rollPers();   // ★ 性格：每代抽 1 个（文案库 §七 第一步）
  evResetEvents();   // ★ 事件日历随新弟子重置
  lgResetLinggen();  // ★ 灵根：每代随机（用户要求）
  zbReset();         // ★ 秘境倾向
  doctrineReset();   // ★ 门装模板 + 训话（Round 18）
  dujieReset();      // ★ 渡劫状态随新弟子重置（Round 20）
  gfResetAll();      // ★ 功法释放计数随新弟子清零（Round 24）
  GF.gfLock = {};    // ★ Round 31：新弟子重新决定功法（锁不继承）
  // ★★ Round 36：开局把【已学会的功法】填进空槽
  //   `GF_KNOWN` 开局送了每类第 1 个（注释："保证开局可玩"），但 `GF.eq` 是空的
  //   ⇒ 5 个技能槽全空 ⇒ "开局可玩"的意图没达成，玩家还得自己选 5 次
  //   ⇒ 这里自动装填；玩家之后手动改会打锁（gfLock），自动逻辑不再覆盖
  try { autoPickGongfa(); } catch (e) { }
  DISCIPLE.lifeGain = 0;
  DISCIPLE.lifeMax = (P.LIFESPAN_YEARS * talLifeMul() + sectBonus().lifeYear) / P.LIFESPAN_YEARS * (P.LIFESPAN_HOURS * 3600);
  SECT.peers = null; // ★ 同门（每代重抽）
  if (sectBonus().qi0 > 0) { G.qi += sectBonus().qi0; G.qiTotal += sectBonus().qi0; }   // ★ 宗门「入门礼」
  // ★ Round 20：宗门把弟子培养到【起始档位】（**消耗素材**）
  //   用户："把弟子培养到一定程度再出门也正常" + "前期的培养肯定也要消耗宗门资源的"
  //   ⚠️ 关键取舍：培养消耗素材 ⇒ 与"锻造门装"抢同一份资源
  {
    const _tr = trainNewDisciple();
    DISCIPLE.trainedTo = _tr.tier;
    if (_tr.tier > 0) { G.tier = _tr.tier; }
  }
  G.tier = 0; G.qi = 0;
  // ★ 提前交接带来的"灵气启动金"：下一代起步就跳过几档（时间压缩，不是战力叠加）
  if (PENDING_QI > 0) {
    const give = PENDING_QI; PENDING_QI = 0;
    gainQi(give);
  }
  initZones();
  G.bag = [];
  G.heroX = 0.5; G.heroY = 0.56;
  if (carried && carried.length) {
    for (const it of carried) G.bag.push(it);
    log(genLab(SECT.generation) + '弟子入门 · 携带传承 ' + carried.length + ' 件', 'ok');
  } else {
    log(genLab(SECT.generation) + '弟子入门 · 从零开始', 'sys');
  }

  // ★★ Round 39 修复（用户报："看不到历练的弟子图片 + 下面怎么是弟子名册"）
  //   根因：本函数只设全局 `DISCIPLE`，【从不把它加进 ROSTER.list】；
  //         而 recruit() 只在 generationalTurnover（弟子死后）调用
  //         ⇒ 开局 ROSTER.list = 0 · ROSTER.front = null
  //         ⇒ ① 「境」页立绘被隐藏（render 里 front 空就 display:none）
  //            ② 「宗」页弟子名册空白　③ 后勤岗位一个都没有
  //   ⇒ 这里把【前线弟子】注册进名册
  registerFrontDisciple();
  //   ⚠️⚠️ 但【不能无条件 recruit】：`generationalTurnover` 已经在弟子死时
  //       "清空前线 → settleBackline → recruit(死亡数)" 补过人了。
  //       newDisciple 由 endDisciple 的 setTimeout 在 turnover 之后调用
  //       ⇒ 这里再 recruit 会【重复招人】（实测：一代招 11 人、出现 2~3 个前线、突破上限 24）
  //   现在 assignDisciple 只分后勤 ⇒ 这里可以安全地补人：
  //     recruit 内部有 room = max(0, slots - alive) + deaths 的上限保护，
  //     满了就一个都不招，不会膨胀。
  recruit(0);
}

// ★ 把当前这一代（全局 DISCIPLE）注册为名册里的【前线弟子】
//   ⚠️ 名册对象与全局 DISCIPLE 是两个分离的对象，各管一半字段：
//        ROSTER 侧：id / name / talent / role / alive / post
//        DISCIPLE 侧：lifespanLeft（秒）/ peakTier / runs / deathCause
//      ⇒ 注册时要双向同步一次（见 syncDisciple()）
const DISC_TO_YEARS = (P.LIFESPAN_HOURS * 3600) / P.LIFESPAN_YEARS;
function registerFrontDisciple() {
  // ★ 派遣（R55）：按依据挑中的那个人【提拔】为历练弟子（复用他的名册条目），
  //   而不是凭空造一个新名字 ⇒ 名册不膨胀，玩家的"选派依据"真起作用
  const _pid = DISCIPLE._prefId;
  const _adopt = (_pid != null)
    ? ROSTER.list.find(function (v) { return v.id === _pid && v.alive; }) : null;
  if (_adopt) {
    _adopt.role = 'front';
    _adopt.tier = DISCIPLE.peakTier | 0;
    _adopt.bornGen = SECT.generation;
    _adopt.talent = TAL.id; _adopt.talentName = TAL.name; _adopt.talentSpeed = TAL.speed;
    _adopt.linggen = LG.id; _adopt.linggenName = (LINGGEN.find(function (x) { return x.id === LG.id; }) || {}).name;
    ROSTER.front = _adopt;
    DISCIPLE._rosterId = _adopt.id;
    DISCIPLE._prefId = null;
    syncDisciple();
    return;
  }
  const d = makeDisciple({ name: DISCIPLE.name, tier: DISCIPLE.peakTier | 0, traits: DISCIPLE.traits });
  // ★ 这一代的前线弟子由【玩家的分派规则】决定（不再是"无条件当前线"）
  //   规则判它不合适 ⇒ 它去后勤，前线留空等下一批
  assignDisciple(d, true);
  if (d.role !== 'front') { d.role = 'front'; }   // 但新一代必须有人挂前线（否则无人历练）
  ROSTER.front = d;
  d.talent = TAL.id; d.talentName = TAL.name; d.talentSpeed = TAL.speed;
  d.linggen = LG.id; d.linggenName = (LINGGEN.find(x => x.id === LG.id) || {}).name;
  d.bornGen = SECT.generation;
  ROSTER.list.push(d);
  ROSTER.front = d;
  DISCIPLE._rosterId = d.id;
  syncDisciple();
  // ★★ Round 39：清理【早已死去】的旧弟子
  //   ⚠️ 死者只被标记 alive=false，【从不从 list 里移除】⇒ 名册只增不减
  //      实测 6 代后名册 27 人（超过 ROSTER_CAP = 24）
  //   ⇒ 前台弟子交接完成后，死者保留在 list 里没有任何用途
  //      （他们的记录已经进了 SECT.history，那是永久的）
  //   ⇒ 这里剪掉所有 !alive 的旧条目，名册回到"当前编制"
  //      注意：不动刚建立的前线（它是 alive 的），历史记录不受影响
  if (ROSTER.list.length > ROSTER_CAP) {
    const keep = ROSTER.list.filter(function (v) { return v.alive; });
    const pruned = ROSTER.list.length - keep.length;
    ROSTER.list.length = 0;
    for (const v of keep) ROSTER.list.push(v);
    if (pruned > 0) ROSTER._pruned = (ROSTER._pruned || 0) + pruned;
  }
  return d;
}

// ★ 把全局 DISCIPLE 的字段同步到名册对象（值变化时调用）
function syncDisciple() {
  const f = ROSTER.front;
  if (!f || !DISCIPLE._rosterId || f.id !== DISCIPLE._rosterId) return;
  f.peakTier = DISCIPLE.peakTier | 0;
  f.runs = DISCIPLE.runs | 0;
  f.tier = Math.max(f.tier | 0, DISCIPLE.peakTier | 0);
  // 寿元：DISCIPLE 用秒，名册用年
  if (DISC_TO_YEARS > 0) f.lifespanLeft = DISCIPLE.lifespanLeft / DISC_TO_YEARS;
}

// ★ 弟子结束：结算传承，自动接下一代
// ★ 传承优先度（用户要求：自动执行，但玩家可设优先度）
//
//   规则用【排序权重】表达，不改"能带几件"（那是 LEGACY_SLOTS 管的）
const LEGACY_RULE = { key: 'power' };
const LEGACY_RULES = {
  power:    { name: '均衡（按综合价值）', desc: '品质 > 品级，不挑部位' },
  weapon:   { name: '优先武器',           desc: '先把攻击类带过去' },
  small:    { name: '优先小件',           desc: '戒指/项链/手足，省空间' },
  speed:    { name: '优先速度向',         desc: '走闪避流' },
  quality:  { name: '只看品质',           desc: '神话优先，不管部位' },
};
const SMALL_SLOTS = ['戒指', '项链', '手', '足', '腰带', '腰'];
const ATK_SLOTS = ['主手', '副手'];
const SPD_SLOTS = ['手', '足'];

function legacyScore(it) {
  const base = it.q * 1000 + it.ilvl * 10;
  switch (LEGACY_RULE.key) {
    case 'weapon':  return base + (ATK_SLOTS.indexOf(it.slot) >= 0 ? 5000 : 0);
    case 'small':   return base + (SMALL_SLOTS.indexOf(it.slot) >= 0 ? 5000 : 0) - it.cells * 200;
    case 'speed':   return base + (SPD_SLOTS.indexOf(it.slot) >= 0 ? 5000 : 0);
    case 'quality': return it.q * 10000 + it.ilvl;
    default:        return base;
  }
}
// 按当前优先度挑 N 件
function legacySlots() {
  return P.LEGACY_SLOTS + (giftOn('slot') ? 1 : 0) + sectBonus().slot;   // ★ 宗门「传承殿」
}
// ★ Round 25：某件传承是否【允许后人穿出去】（神话可被徽记封印）
function legacyAllowed(it) {
  return !(SECT.legacyBan && SECT.legacyBan[it.id]);
}
// 切换徽记（神话专属）
function toggleLegacyBan(id) {
  if (!SECT.legacyBan) SECT.legacyBan = {};
  if (SECT.legacyBan[id]) delete SECT.legacyBan[id];
  else SECT.legacyBan[id] = true;
  return !!SECT.legacyBan[id];
}
function pickLegacy(owned, n) {
  // 被徽记封印的不能直传（它们只进宝库，玩家可用荣誉点取出）
  return owned.slice().filter(legacyAllowed)
    .sort((a, b) => legacyScore(b) - legacyScore(a)).slice(0, n);
}
// 旧实现（保留说明）
function pickLegacy_old(owned, n) {
  return owned.slice().sort((a, b) => legacyScore(b) - legacyScore(a)).slice(0, n);
}

function endDisciple(cause) {
  DISCIPLE.deathCause = cause;
  sfx('death');                     // ★ R60：弟子死了 —— 一局只响一次，必须响
  const gen = SECT.generation;
  const owned = buildFingerprint().concat(G.bag);
  let carried = [], lost = [];
  if (cause === 'handover') {
    // 提前交接：传承【完整】带回（与善终同等），因为弟子是主动走的
    carried = pickLegacy(owned, legacySlots());
    const ids = new Set(carried.map(x => x.id));
    SECT.legacyPool.push(...owned.filter(x => !ids.has(x.id)));
    ev('death_handover', 7, {});
    log('✦ 第 ' + gen + ' 代弟子提前交接传承 · 完整带回（' + owned.length + ' 件）', 'break');
  } else if (cause === 'old_age') {
    // 善终：按优先度直传 N 件，其余进传承池（完整带回）
    carried = pickLegacy(owned, legacySlots());
    const carriedIds = new Set(carried.map(x => x.id));
    SECT.legacyPool.push(...owned.filter(x => !carriedIds.has(x.id)));
    ev('death_old', 7, {});
    log('✦ 第 ' + gen + ' 代弟子寿元耗尽 · 善终回宗门 · 传承完整带回（' + owned.length + ' 件）', 'break');
  } else {
    // 战斗身亡：按优先度自动取回一部分，其余遗落在死地
    // ★ 器物不损：有该给赠时，身亡也不遗落（完整带回）
    const keepAll = giftOn('keep');
    const taken = keepAll ? owned.length
      : Math.min(P.LEGACY_SLOTS, Math.floor(owned.length / 2));
    carried = pickLegacy(owned, taken);
    const carriedIds = new Set(carried.map(x => x.id));
    lost = owned.filter(x => !carriedIds.has(x.id));
    SECT.lostLegacy.push(...lost);
    // ★★ Round 34：记录"死在哪"（Z2：同一秘境战死 3 次 ⇒ 自动成形负门规）
    try { ruleNoteDeath(zbNow() && zbNow().name); } catch (e) { }
    ev('death_battle', 7, { lost: lost.length });
    log('💀 第 ' + gen + ' 代弟子身亡于秘境 · 传承遗落 ' + lost.length +
      ' 件（弟子会自动去搜寻）· 按「' + LEGACY_RULES[LEGACY_RULE.key].name + '」取回 ' + taken + ' 件', 'bad');
  }
  if (DISCIPLE.peakTier >= P.TIERS - 1) {
    if (!SECT.ascended) { SECT.ascended = true; addHonor(100, '首位弟子羽化飞仙'); }
  }
  // ★ 宗门：按弟子一生的成就发放荣誉点
  addHonor(honorForDisciple(), genLab(gen) + '弟子的一生');
  // ★ 叙事层：记录宗门见过的最高修为（长老任期基准）
  if (DISCIPLE.peakTier > (SECT.topTier || 0)) SECT.topTier = DISCIPLE.peakTier;
  // ★★ Round 43：把这一代的生平快照存档（G.log 会滚动淘汰，且不进存档）
  try { snapshotChronicle(gen); } catch (e) { }
  SECT.history.push({
    gen, cause, tier: DISCIPLE.peakTier, runs: DISCIPLE.runs,
    name: DISCIPLE.name || '',                              // ★ 名字（原来历代名会丢）
    pers: DISCIPLE.pers || null,
    traits: (DISCIPLE.traits || []).slice(),                // ★ 天赋条目随史册
    lifeYears: Math.round(lifeMaxYears()),                 // ★ 死亡瞬间快照（事后反推会被加成改写）
    realmAtDeath: P.REALMS[realmOf(DISCIPLE.peakTier | 0)] || '',
    title: deriveTitle(gen),                                // ★ 称号（§四）
    hi: topEventSnap(),                                     // ★ 风光素材（§三；EVENTS 会被清空）
    hoursLeft: Math.round(DISCIPLE.lifespanLeft / 36) / 100,
    carried: carried.length, lost: lost.length,
  });
  if (SECT.history.length > 40) SECT.history.shift();
  // ★ Round 22：世代交替 —— 后勤结算 + 招徒
  //   用户："按前线弟子死亡或者回宗门后结算…结算后对比后勤弟子的寿元，
  //         够的减去消耗继续活，不够的直接死，死了空出来的位置就用新的弟子补充"
  { try { generationalTurnover(cause); } catch (e) { } }
  // ★ 自动接下一代（挂机不卡死）
  //   ⚠️⚠️ Round 39 加固：原来【没有 try/catch】
  //      ⇒ 若 newDisciple 抛一次异常，这个回调就死了
  //      ⇒ 游戏【永久卡在 rest】、ROSTER.front 永远是 null
  //      ⇒ 用户看到：「前线空缺（等宗门补员）」+ 立绘消失 + 底部导航不见
  setTimeout(function () {
    try {
      newDisciple(carried);
    } catch (e) {
      G.nextDiscipleErr = (G.nextDiscipleErr || 0) + 1;
      G.lastNextErr = String(e && e.message || e);
      try { console.error('newDisciple failed:', e); } catch (_) { }
    }
  }, 800);
}

// ---------------- 三之二·五、搜寻遗落传承（用户提案 B）----------------
//
//   "到达对应位置以后需要花一点时间寻找，自动的就行"
//
//   机制：弟子每逢"某一局结束"就有机会发起一次搜寻
//     · 搜寻耗时数局（进度条显示）
//     · 完成后按【弟子修为 vs 遗落深度】决定取回几件
//     · 取不回的留在列表里，等更强的后辈
const SEARCH = { active: false, left: 0, total: 0, found: 0, target: 0 };
function startSearch() {
  if (SECT.lostLegacy.length === 0 || SEARCH.active) return false;
  SEARCH.active = true;
  SEARCH.total = P.SEARCH_RUNS;
  SEARCH.left = P.SEARCH_RUNS;
  SEARCH.found = 0;
  ev('search_start', 4, { n: SECT.lostLegacy.length });
  log('派遣弟子搜寻遗落传承…（约需 ' + P.SEARCH_RUNS + ' 局）', 'sys');
  return true;
}
function tickSearch() {
  if (!SEARCH.active) return;
  SEARCH.left--;
  if (SEARCH.left > 0) return;
  // 搜寻完成：按修为深浅决定能取回多少
  SEARCH.active = false;
  const depth = P.LOST_DEPTH;                       // 遗落深度（修为档）
  const myPower = G.tier;
  // 修为达到深度 ⇒ 全取回；差距越大取回越少
  const ratio = depth <= 0 ? 1 : Math.min(1, 0.35 + myPower / Math.max(1, depth) * 0.65);
  const cap = Math.max(1, Math.round(SECT.lostLegacy.length * ratio));
  const got = SECT.lostLegacy.splice(0, cap);
  SECT.legacyPool.push(...got);
  SEARCH.found = got.length;
  ev('legacy_get', 6, { n: got.length });
  if (SECT.lostLegacy.length === 0) {
    log('✦ 搜寻完毕 · 取回全部遗落传承（' + got.length + ' 件）', 'ok');
  } else {
    log('搜寻完毕 · 取回 ' + got.length + ' 件（尚余 ' + SECT.lostLegacy.length +
      ' 件，需更强的弟子前往）', 'ok');
  }
}
// 从传承池里按优先度取一件给当前弟子（自动）
function autoTakeFromPool() {
  if (SECT.legacyPool.length === 0) return null;
  SECT.legacyPool.sort((a, b) => legacyScore(b) - legacyScore(a));
  return SECT.legacyPool.shift();
}


// ---------------- 三之四、存档与离线结算 ----------------
//
// 多世代结构【必须有存档】——否则刷新一次就丢掉：
//   第几代、传承池、遗落列表、历代记录
const SAVE_KEY = 'miyu_save_v1';
const SAVE_VER = 1;

// 装备扁平化（不存 _anchor 之类运行时状态）
function serItem(it) {
  // ★ 非装备条目（功法书 / 法宝）走单独分支 —— 它们没有 slot/shape/mainVal
  if (it.kind2) return { k2: it.kind2, key: it.gfId || it.fbId, q: it.q };
  return { s: it.slot, i: Math.round(it.ilvl * 10) / 10, q: it.q,
    w: it.weapon || 0, m: it.mainVal, k: it.kind, h: it.home,
    af: it.affixes || null, n: it.name || null };
}
function deserItem(o) {
  // ★ 非装备条目
  if (o.k2) {
    const it = (o.k2 === 'gongfa') ? makeGongfaItem(o.key) : makeFabaoItem(o.key);
    it.q = o.q;
    return it;
  }
  const it = makeItem(o.i, o.q);
  it.slot = o.s; it.home = o.h; it.shape = SHAPES[o.s][o.q];
  it.cells = it.shape[0] * it.shape[1]; it.kind = o.k;
  it.weapon = o.w || null;
  it.affixes = o.af || [];
  it.mainVal = o.m; it.main = o.m;
  it.name = o.n || null;
  return it;
}
// 分区场景 → 紧凑结构
//
// ⚠️ 必须理解 place() 的真实结构（第 1560 行）：
//   锚点格    = { _anchor: true, ...it 的副本 }   ← 是【副本】，不是原对象！
//   非锚点格  = { _part: true, ref: 原对象 it }    ← ref 指向 it（副本之外的另一个对象）
//   ⇒ 所以 part 格的 ref 【不能】直接拿去找锚点载荷，必须靠原对象映射间接找
//     （我第一版就写成 `cell._anchor === it`，永远为 false ⇒ 同一件装备被当成多件）
function serZones() {
  const items = [], anchorOf = new Map(), zones = {};
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z], cells = [];
    for (let y = 0; y < zc.h; y++) {
      const row = [];
      for (let x = 0; x < zc.w; x++) {
        const c = zc.cells[y][x];
        if (!c) { row.push(0); continue; }
        if (c._anchor) {
          items.push(serItem(c));                  // ★ 必须过 serItem（扁平格式），不能存原始对象
          anchorOf.set(c, items.length);
          if (c.id != null) anchorOf.set('id:' + c.id, items.length);
          row.push(items.length);                  // 正数 = 锚点
        } else if (c._part && c.ref) {
          // 先用 ref 本身找；找不到就用它的 id 兜底
          let v = anchorOf.get(c.ref) || anchorOf.get('id:' + c.ref.id);
          if (!v) { items.push(serItem(c.ref)); v = items.length; anchorOf.set(c.ref, v); }
          row.push(-v);                            // 负数 = 非锚点，指向同一件装备
        } else { row.push(0); }
      }
      cells.push(row);
    }
    zones[z] = cells;
  }
  return { items, zones };
}
function deserZones(o) {
  initZones();
  const objs = (o.items || []).map(payload => {
    const it = deserItem(payload);
    it._anchor = true;                               // 锚点格对象自身
    return it;
  });
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z], rows = o.zones && o.zones[z];
    if (!rows) continue;
    for (let y = 0; y < zc.h && y < rows.length; y++)
      for (let x = 0; x < zc.w && x < rows[y].length; x++) {
        const v = rows[y][x];
        if (!v) continue;
        const it = objs[Math.abs(v) - 1];
        if (!it) continue;
        if (v > 0) { it._px = x; it._py = y; zc.cells[y][x] = it; }
        else { zc.cells[y][x] = { _part: true, ref: it }; }
      }
  }
}

function saveGame() {
  // ★★ Round 32 修复：「重新开始」失效的真凶
  //   location.reload() 会触发 beforeunload / visibilitychange
  //   ⇒ 那些 handler 调用 saveGame() ⇒ 【把旧状态写回 localStorage】
  //   ⇒ 重开后又读回旧档（用户报："我点了重新开始怎么直接给我变成仙门了"）
  if (globalThis.__DSH_RESETTING) return;
  try {
    const z = serZones();
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: SAVE_VER,
      tier: G.tier, qi: G.qi, qiTotal: G.qiTotal, breakCount: G.breakCount,
      origin: G.origin,   // ⚠️ Round 18：materials 已搬到 sect 段（SECT_RES）
      totalKills: G.totalKills, runs: G.runs,
      dropped: G.dropped, disenchanted: G.disenchanted,
      filterQ: G.filterQ, onlyUpgrade: G.onlyUpgrade,
      rule: LEGACY_RULE.key,
      sect: { g: SECT.generation, ascended: SECT.ascended, chronicle: SECT.chronicle, history: SECT.history,
        honor: SECT.honor, rank: SECT.rank, up: SECT.up,
        elders: SECT.elders, sectMaster: SECT.sectMaster, topTier: SECT.topTier,
      sectMat: SECT_RES.materials, sectForged: SECT_RES.forged, sectSpent: SECT_RES.spent,
      trainLevel: TRAIN.level,
      talent: TAL.id, lifeGain: DISCIPLE.lifeGain, lifeMax: DISCIPLE.lifeMax,
      doctrine: SECT_DOCTRINE,
        pool: SECT.legacyPool.map(serItem), lost: SECT.lostLegacy.map(serItem),
        legacyBan: SECT.legacyBan,
        vaultPolicy: VAULT.policy, vaultOverride: VAULT.override, vaultStat: VAULT.stat },
      disc: { left: DISCIPLE.lifespanLeft, peak: DISCIPLE.peakTier, runs: DISCIPLE.runs, pers: DISCIPLE.pers || null,
        traits: (DISCIPLE.traits || []).slice() },
      items: z.items, zones: z.zones, bag: G.bag.map(serItem),
      // ★ 功法学会表 / 法宝拥有表（Round 12：改为掉落进背包 ⇒ 必须存）
      gfKnown: GF_KNOWN, gfEq: GF.eq, fbOwned: FB_OWNED, fbEq: FB.eq,
      gfPrio: GF.prio, gfLock: GF.gfLock,
      // ★★ Round 33 修复（审计发现）：ROSTER（多弟子名册）原来【完全没进存档】
      //   ⇒ 刷新即丢：后勤弟子、在册人数、分派规则、前线归属全部消失
      //   弟子对象是纯数据 ⇒ 直接存；front 是【对象引用】⇒ 存 id，读档时重连
      roster: {
        list: ROSTER.list.map(function (d) { return Object.assign({}, d); }),
        nextId: ROSTER.nextId,
        rule: ROSTER.rule,
        recruitEveryRuns: ROSTER.recruitEveryRuns,
        frontId: ROSTER.front ? ROSTER.front.id : null,
        pickBy: ROSTER.pickBy || 'talent',      },
      linggen: (LG.id ? { id: LG.id, els: LG.els } : null),
      pvpPool: PVP.pool.slice(-60), pvpStreak: PVP.streak, pvpLog: PVP.lastLog,
      killRate: G.lastKillRate, pressure: G.lastPressure,
      at: Date.now(),
    }));
    return true;
  } catch (e) { console.warn('存档失败', e); return false; }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || d.v !== SAVE_VER) return false;   // 版本不符 ⇒ 弃档（原型阶段可接受）
    G.tier = d.tier | 0; G.qi = d.qi | 0;
    G.qiTotal = d.qiTotal | 0; G.breakCount = d.breakCount | 0;
    G.origin = d.origin | 0;   // ⚠️ Round 18：素材在下面按 sect.sectMat 读回
    G.totalKills = d.totalKills | 0; G.runs = d.runs | 0;
    G.dropped = d.dropped | 0; G.disenchanted = d.disenchanted | 0;
    G.filterQ = d.filterQ | 0; G.onlyUpgrade = !!d.onlyUpgrade;
    if (d.rule && LEGACY_RULES[d.rule]) LEGACY_RULE.key = d.rule;
    SECT.generation = (d.sect && d.sect.g) | 0;
    SECT.ascended = !!(d.sect && d.sect.ascended);
    SECT.chronicle = (d.sect && d.sect.chronicle) || {};   // ★ Round 43
    SECT.history = (d.sect && d.sect.history) || [];
    if (d.linggen && d.linggen.id) {
      const g = LINGGEN.find(x => x.id === d.linggen.id);
      if (g) { Object.assign(LG, g); LG.els = d.linggen.els || []; }
    }
    SECT.honor = (d.sect && d.sect.honor) | 0;
    SECT.up = (d.sect && d.sect.up) || {};
    // ★ 叙事层：读回长老/宗主（旧档无则 null，ensureElders 补建）
    SECT.elders = (d.sect && d.sect.elders) || null;
    SECT.sectMaster = (d.sect && d.sect.sectMaster) || null;
    SECT.topTier = (d.sect && d.sect.topTier) || 0;
    ensureElders();
    SECT_RES.materials = (d.sect && d.sect.sectMat) | 0;
    SECT_RES.forged = (d.sect && d.sect.sectForged) | 0;
    SECT_RES.spent = (d.sect && d.sect.sectSpent) | 0;
    TRAIN.level = (d.sect && d.sect.trainLevel) | 0;
    if (d.sect && d.sect.talent) { const g = TALENTS.find(x => x.id === d.sect.talent); if (g) Object.assign(TAL, g); }
    DISCIPLE.lifeGain = (d.sect && d.sect.lifeGain) || 0;
    DISCIPLE.lifeMax = (d.sect && d.sect.lifeMax) || (P.LIFESPAN_HOURS * 3600);
    if (d.sect && d.sect.doctrine && d.sect.doctrine.want) Object.assign(SECT_DOCTRINE, d.sect.doctrine);
    // ★★ Round 34：读回门规
    if (d.sect && Array.isArray(d.sect.doctrineRules)) {
      SECT_DOCTRINE.rules = d.sect.doctrineRules.filter(function (r) {
        return r && r.id && r.axis && AXIS_NAME[r.axis];
      });
    }
    if (d.sect && Array.isArray(d.sect.doctrineBanZones)) {
      SECT_DOCTRINE.bannedZones = d.sect.doctrineBanZones.slice();
    }
    if (d.sect && d.sect.doctrineDeathByZone) {
      SECT_DOCTRINE.deathByZone = d.sect.doctrineDeathByZone;
    }
    refreshSectRank();
    SECT.legacyPool = ((d.sect && d.sect.pool) || []).map(deserItem);
    SECT.lostLegacy = ((d.sect && d.sect.lost) || []).map(deserItem);
    DISCIPLE.lifespanLeft = d.disc.left;
    DISCIPLE.peakTier = d.disc.peak | 0;
    DISCIPLE.pers = (d.disc && d.disc.pers) || null;   // ★ 性格（老档无 ⇒ null ⇒ 降级通用池）
    DISCIPLE.traits = (d.disc && d.disc.traits) || [];  // ★ 天赋条目（老档无 ⇒ 空）
    DISCIPLE.runs = d.disc.runs | 0;
    DISCIPLE.born = Date.now() - (P.LIFESPAN_HOURS * 3600 - DISCIPLE.lifespanLeft) * 1000;
    deserZones(d);
    G.bag = (d.bag || []).map(deserItem);
    // ★ 功法学会表 / 法宝拥有表（Round 12）
    if (d.gfKnown) Object.keys(GF_KNOWN).forEach(k => { GF_KNOWN[k] = !!d.gfKnown[k]; });
    // ★ Round 24 修复：原来【漏存 GF.eq】⇒ 一刷新"装了哪几个功法"就丢了
    //   （用户报"刷新以后功法没了"）
    if (d.gfEq && typeof d.gfEq === 'object') {
      GF.eq = {};
      for (const ty of GF_TYPES) {
        const id = d.gfEq[ty];
        if (id && GF_BY_ID[id] && GF_KNOWN[id]) GF.eq[ty] = id;
      }
    }
    if (Array.isArray(d.gfPrio)) GF.prio = d.gfPrio.filter(id => !!GF_BY_ID[id]);
    if (d.gfLock && typeof d.gfLock === 'object') GF.gfLock = d.gfLock;   // ★ Round 31
    // ★★ Round 33：读回多弟子名册（front 用 id 重连，避免循环引用）
    if (d.roster) {
      ROSTER.list = Array.isArray(d.roster.list) ? d.roster.list.map(function (x) {
        return Object.assign({ alive: true, role: 'idle', post: null, runs: 0, peakTier: 0 }, x);
      }) : [];
      ROSTER.nextId = Math.max(1, d.roster.nextId | 0,
        ROSTER.list.reduce(function (m, x) { return Math.max(m, (x.id | 0) + 1); }, 1));
      if (d.roster.rule) ROSTER.rule = d.roster.rule;
      ROSTER.recruitEveryRuns = (d.roster.recruitEveryRuns == null)
        ? 99 : (d.roster.recruitEveryRuns | 0);
      ROSTER.front = ROSTER.list.find(function (x) { return x.id === d.roster.frontId; }) || null;
      if (ROSTER.front && !ROSTER.front.alive) ROSTER.front = null;
      ROSTER.pickBy = d.roster.pickBy || 'any';   // ★ 派遣依据
    }
    if (d.fbOwned) Object.keys(FB_OWNED).forEach(k => { FB_OWNED[k] = !!d.fbOwned[k]; });
    if (Array.isArray(d.fbEq)) FB.eq = d.fbEq.filter(id => !!FABAO_BY_ID[id]);
    if (Array.isArray(d.pvpPool)) PVP.pool = d.pvpPool;
    PVP.streak = d.pvpStreak | 0;
    PVP.lastLog = d.pvpLog || [];
    G.lastKillRate = d.killRate || 0;
    G.lastPressure = d.pressure != null ? d.pressure : null;
    G._savedAt = d.at || Date.now();
    return true;
  } catch (e) { console.warn('读档失败', e); return false; }
}

// ★ 离线结算（用户决策："就现实时间"）
//   · 寿元照常流逝（离线也在变老 ⇒ 回来要处理）
//   · 按【上一局的击杀速率】折算产出，并封顶 OFFLINE_CAP_HOURS
//   · 掉落只给素材 + 统计，不逐件生成（避免撑爆背包）
// ★ R67：把"离开期间按真实时间结算"抽成【唯一公式】。
//   ⚠️ 离线（关页面）与后台（切标签页）必须走同一套，否则两套口径必然漂 ——
//      这次就是靠这次重构才发现旧代码的【单位串了】（rate 是"只/游戏秒"，
//      而时长是"真实秒" ⇒ 实际效率只有标称值的 1/2.5）。
//
//   参数一律用【真实秒 + 只/真实秒】口径：
//     rateReal = (G.kills / G.t) × CLOCK_RATIO   ← G.t 是游戏秒，要换算
function settleAway(awaySec, eff, capSec) {
  const capped = Math.min(awaySec, capSec);
  if (!(capped > 0)) return null;
  const before = DISCIPLE.lifespanLeft;
  DISCIPLE.lifespanLeft = Math.max(0, DISCIPLE.lifespanLeft - capped);

  // 只/游戏秒 → 只/真实秒（在线 1 真实秒 = CLOCK_RATIO 游戏秒）
  const rateQ = G.lastKillRate > 0 ? G.lastKillRate : P.OFFLINE_RATE_FALLBACK;
  const rate = rateQ * CLOCK_RATIO;
  const kills = Math.floor(rate * capped * eff);
  const qi = kills * P.QI_PER_KILL;
  const drops = Math.floor(kills * DROP.PER_KILL);
  G.dropped += drops;
  SECT_RES.materials += drops * P.OFFLINE_MATERIAL_PER_DROP;   // ★ Round 18：素材进宗门
  G.totalKills += kills;
  if (qi > 0) gainQi(qi);

  // ★ 2026-10-16 用户："产出按离线时间记录" —— 离线期间各部也在产出。
  //   折算：离线折合届数 = 离线秒数 / 一届时元（P.LIFESPAN_HOURS）；与 live 「每届结算」同口径。
  const offGens = capped / (P.LIFESPAN_HOURS * 3600);
  if (offGens > 0) {
    const ob = backlineBonus();
    const om = Math.round((ob.mats || 0) * offGens);
    if (om > 0) { SECT_RES.materials += om; SECT_RES.forgedMats = (SECT_RES.forgedMats || 0) + om; }
    let offHealed = 0;
    const backs = ROSTER.list.filter(d => d.alive && d.role === 'back');
    if (ob.life > 0 && backs.length) {
      const add = Math.round(ob.life * offGens);
      // ★ 封顶：离线只花【这一趟挣到的】素材 —— 离线结算不该把你花穷
      //   （不然 applyOffline 之后素材可能净减少，与"离线有收益"的语义冲突）
      const cost = Math.min(add * backs.length * 8, om);
      if (cost > 0) { SECT_RES.materials -= cost; for (const d of backs) { d.lifespanLeft += add; offHealed++; } }
    }
    facYieldAdd(ob, offGens, offHealed);
  }

  const died = before > 0 && DISCIPLE.lifespanLeft <= 0;
  // 离线期间寿元耗尽 ⇒ 当场结算传承（不能只靠 boot 的定时器，否则状态会停在半路）
  if (died) log('☾ 离线期间寿元耗尽 · 弟子坐化，传承待结算', 'bad');
  ev('offline', 6, { kills, qi, drops, hours: capped / 3600 });
  return { away: capped, kills, qi, drops, died };
}

/** 离线：关页面后重开（保留 120 秒门槛 —— 太短的窗口切换不该走"离线"口径）。 */
function applyOffline() {
  const away = (Date.now() - (G._savedAt || Date.now())) / 1000;
  if (away < 120) return null;
  return settleAway(away, P.AWAY_EFFICIENCY, P.OFFLINE_CAP_HOURS * 3600);
}

/** ★ R67：后台：切标签页期间。与离线【分开】——门槛低（BG_MIN_SECONDS）、效率高（BG_EFFICIENCY）。
 *  这是"在线 = 看打 / 离开 = 结算"这条分工的落地：后台不再指望 tick 龟速跑。 */
function settleBackground() {
  if (!G._bgAt) return null;
  const away = (Date.now() - G._bgAt) / 1000;
  G._bgAt = 0;
  if (away < P.BG_MIN_SECONDS) return null;              // 太短不结算
  if (!G.running) return null;                           // 没在打就不算
  const r = settleAway(away, P.BG_EFFICIENCY, P.BG_CAP_SECONDS);
  if (r && r.kills > 0) {
    log('◷ 离开 ' + Math.round(away) + ' 秒 · 击杀 +' + r.kills + ' · 灵气 +' + r.qi +
      '（后台结算 ' + Math.round(P.BG_EFFICIENCY * 100) + '%）', 'ok');
  }
  return r;
}

// ---------------- 三之二·八、功法（五类各 1 槽 · BD 深度主体）----------------
//
// 设计依据（设计规格_功法系统.md）：
//   · 五类各 1 槽：心法 / 身法 / 攻伐 / 护体 / 秘术
//   · 每类对应一个独立的【质变轴】，跨类不可替代（身法替代不了攻伐）
//   · 触发模型：周期型（每 N 次出手）/ 条件型 / 事件型
//   · 冲突仲裁：事件型 > 条件型 > 周期型；同一刻度最多 1 个"占出手"效果
//   · 增强型为主、释放型为辅（释放型占出手 ⇒ 必须给足补偿）
//
// ⚠️ 数值是原型自拟的起点，需后续配平
const GF_TYPES = ['心法', '身法', '攻伐', '护体', '秘术'];

const GONGFA = [
  // ---- 心法（4 条）----
  { id: 'x_ningshen', type: '心法', name: '凝神归元',
    desc: '血量 <30% 时：立即回复 40% 生命，并减伤 25%（持续 4 秒）',
    trigger: '条件·保命', enhance: true, modal: '主动', cd: 'sec', cdN: 12 },
  // ---- 心法原有 3 条 ----
  { id: 'x_fashi', type: '心法', name: '焚心诀',
    desc: '每击杀 1 只攻击 +0.9%（可叠 12 层）；停手 6 秒后层数减半',
    trigger: '条件·累积', enhance: true, modal: '被动', fb: { atk: 0.03 } },
  { id: 'x_tuna', type: '心法', name: '吐纳术',
    desc: '停手 3 秒后，下次出手伤害 ×1.6 且额外多打 2 个目标\n兜底：攻击 +3%',
    trigger: '机制改写', enhance: true, modal: '被动', fb: { atk: 0.03 } },
  { id: 'x_qingxin', type: '心法', name: '清心咒',
    desc: '血量 <40% 时：闪避 +18%（持续 3 秒）\n兜底：承压伤害 −3%',
    trigger: '条件·保命', enhance: true, modal: '主动', cd: 'sec', cdN: 8, fb: { dmgTaken: 0.97 } },
  // ---- 身法：出手频率与命中（时序乘区 + 判定链）----
  { id: 's_zhuifeng', type: '身法', name: '追风步',
    desc: '每击杀 5 只出手频率 +4%（可叠 6 层）\n兜底：出手频率 +3%',
    trigger: '条件·累积', enhance: true, modal: '被动', fb: { freq: 0.03 } },
  { id: 's_lingbo', type: '身法', name: '凌波微步',
    desc: '每次成功闪避后，接下来 3 次出手频率 +35%\n兜底：闪避 +3%',
    trigger: '机制改写', enhance: true, modal: '被动', fb: { evade: 0.03 } },
  { id: 's_suodi', type: '身法', name: '缩地成寸',
    desc: '每 10 次出手：接下来 3 次出手必定暴击、额外多打 2 个目标',
    trigger: '周期', enhance: true, modal: '主动', cd: 'swing', cdN: 10 },
  // ---- 攻伐（4 条）----
  { id: 'g_wanjian', type: '攻伐', name: '万剑归宗',
    desc: '每 30 游戏秒：对全场造成巨额伤害（×6）',
    trigger: '纯主动', enhance: false, modal: '主动', cd: 'sec', cdN: 30 },
  // ---- 攻伐原有 3 条 ----
  { id: 'g_zhan', type: '攻伐', name: '裂空斩',
    desc: '每 10 次出手，释放范围斩：伤害 ×2.2，额外多打 4 个目标',
    trigger: '周期', enhance: false, modal: '主动', cd: 'swing', cdN: 10 },
  { id: 'g_lei', type: '攻伐', name: '天雷引',
    desc: '每 12 次出手，引落天雷：额外打 10 个目标，伤害 ×1.8',
    trigger: '周期', enhance: false, modal: '主动', cd: 'swing', cdN: 12 },
  { id: 'g_po', type: '攻伐', name: '破军式',
    desc: '威胁圈内 ≥3 只时伤害 +25%，但承压伤害 +10%\n兜底：攻击 +3%',
    trigger: '条件·局面', enhance: true, modal: '被动', fb: { atk: 0.03 } },
  // ---- 护体（4 条）----
  { id: 'h_jinzhong', type: '护体', name: '金钟罩',
    desc: '受击或低血时：立即获得护盾（28% 最大生命，存续 4 秒）',
    trigger: '条件·保命', enhance: true, modal: '主动', cd: 'sec', cdN: 14 },
  // ---- 护体原有 3 条 ----
  { id: 'h_jingang', type: '护体', name: '金刚体',
    desc: '受击后承压阈值 +4（持续 2 秒）\n兜底：承压伤害 −3%',
    trigger: '条件·响应', enhance: true, modal: '主动', cd: 'sec', cdN: 6, fb: { dmgTaken: 0.97 } },
  { id: 'h_huichun', type: '护体', name: '回春术',
    desc: '每 15 次出手，回复 4% 生命',
    trigger: '周期', enhance: false, modal: '主动', cd: 'swing', cdN: 15 },
  { id: 'h_guixi', type: '护体', name: '龟息功',
    desc: '承压伤害 −30%，但出手频率 −15%',
    trigger: '机制·永续', enhance: true, modal: '被动', fb: {} },
  // ---- 秘术：资源与特殊效果（状态乘区）----
  { id: 'm_hunli', type: '秘术', name: '魂力积蕴',
    desc: '击杀累积魂力，满 100 时清场一片（全场 ×3 伤害）',
    trigger: '事件', enhance: false, modal: '主动', cd: 'run', cdN: 1 },
  { id: 'm_lianqi', type: '秘术', name: '炼气化神',
    desc: '每击杀 20 只，额外获得 60 灵气\n兜底：灵气 +3%',
    trigger: '事件', enhance: true, modal: '被动', fb: { qi: 0.03 } },
  { id: 'm_juxian', type: '秘术', name: '聚灵阵',
    desc: '每 20 次出手，灵气 +40',
    trigger: '周期', enhance: false, modal: '主动', cd: 'swing', cdN: 20 },
];
const GF_BY_ID = {};
GONGFA.forEach(g => GF_BY_ID[g.id] = g);

// 运行时状态
const GF = {
  eq: {},                 // { 心法: 'x_fashi', ... } 每类最多 1 个
  swings: 0,              // 本局出手次数（周期型用）
  killStack: 0,           // 焚心诀层数
  speedStack: 0,          // 追风步层数
  soul: 0,                // 魂力
  idleT: 0,               // 停手累计秒数（吐纳术 / 焚心诀用）
  holdT: 0,               // 距上次击杀的秒数（焚心诀用）
  lingboT: 0,             // 凌波微步：剩余提速出手次数
  // ★ 主动技能的冷却状态（设计规格_功法主动技能方案.md）
  prio: [],
  // ★ Round 31（用户要求："功法不要学了不用，要学了就用"）
  //   lock = 玩家【手动选过】的槽位 ⇒ 自动逻辑不再覆盖它
  //   没锁的槽位 ⇒ 自动挑最强的
  gfLock: {},               // 玩家预设的优先级（可调）
  lastSwing: {},          // cd='swing'：上次释放的出手数
  lastSec: {},            // cd='sec'：上次释放的游戏秒
  usedRun: {},            // cd='run'：本局是否已用
  critWindow: 0,          // ★ 缩地成寸：剩余必暴出手次数
  fired: {},              // 统计：各技能本局释放次数
  _releaseSoul: false,
};

// ★ 已学会的功法（用户要求：功法应该像装备一样掉落，然后供玩家选择装备）
//   初始只给每类第 1 个（保证开局可玩），其余靠掉落学会
const GF_KNOWN = {};
GONGFA.forEach(g => { GF_KNOWN[g.id] = false; });
// 初始赠送：每类第 1 个
GF_TYPES.forEach(tp => { const g = GONGFA.find(x => x.type === tp); if (g) GF_KNOWN[g.id] = true; });

function gfOf(type) { return GF.eq[type] ? GF_BY_ID[GF.eq[type]] : null; }
function gfOn(id) { return Object.values(GF.eq).includes(id); }
// 装备/卸下（同一类互斥）
// ★ 从背包里的功法书获得该功法：学会 + 立刻装上
//   （用户要求：现在手动装；后续会做自动装备）
function grantGongfa(id) {
  if (!GF_BY_ID[id]) return false;
  GF_KNOWN[id] = true;
  gfEquip(id);          // 同类互斥，自动替换
  return true;
}
// ★ 从背包里的法宝获得该法宝：登记拥有 + 立刻装上
function grantFabao(id) {
  if (!FABAO_BY_ID[id]) return false;
  FB_OWNED[id] = true;
  if (!FB.eq.includes(id)) {
    if (FB.eq.length >= FABAO_SLOTS) FB.eq.shift();
    FB.eq.push(id);
  }
  return true;
}
// ★ Round 31（用户要求："功法不要学了不用，要学了就用"）
//   按下述规则把【已学会】的功法填进 5 个槽：
//     · 玩家手动选过的槽（GF.gfLock[type]）⇒ 不动
//     · 空槽 ⇒ 填该类型里评分最高的
//     · 已占但没锁 ⇒ 换成评分更高的（"学了就用"）
//   主动功法优先于被动（主动技能能打出爆发/保命）
function gfScore(g) {
  if (!g) return -1;
  let s = (g.modal === "主动") ? 100 : 0;   // 主动优先
  s += (g.layers || 1) * 5;
  s += (g.cdN || 0) * 0.1;
  return s;
}
function autoPickGongfa() {
  const changed = [];
  for (const ty of GF_TYPES) {
    if (GF.gfLock && GF.gfLock[ty]) continue;      // 玩家锁了 ⇒ 不动
    const pool = GONGFA.filter(g => g.type === ty && GF_KNOWN[g.id]);
    if (!pool.length) continue;
    let best = pool[0];
    for (const g of pool) if (gfScore(g) > gfScore(best)) best = g;
    if (GF.eq[ty] !== best.id) {
      GF.eq[ty] = best.id;
      changed.push(ty + "·" + best.name);
    }
  }
  if (changed.length) log("✦ 功法调整：" + changed.join("、"), "ok");
  return changed;
}
function gfEquip(id, manual) {
  const g = GF_BY_ID[id];
  if (!g) return false;
  GF.eq[g.type] = id;
  // ★ Round 31：玩家手动选的 ⇒ 打锁（自动逻辑不再覆盖）
  if (manual) { GF.gfLock = GF.gfLock || {}; GF.gfLock[g.type] = true; }
  return true;
}
// 本局开始：清空运行时层数
function gfResetRun() {
  GF.swings = 0; GF.swingW = 0; GF.killStack = 0; GF.speedStack = 0; GF.soul = 0;
  GF.idleT = 0; GF.holdT = 0; GF.lingboT = 0;
  // ★ 冷却初始化：设为【当前时刻】
  //   ⚠️ 原来是空对象 ⇒ 首次检查视为"从未用过" ⇒ 【第 1 次出手就放技能】
  //      （应该第 cdN 次才放）。现在初始化为 -cdN（即"刚好冷却完"）。
  GF.lastSwing = {}; GF.lastSec = {}; GF.usedRun = {};
  // ★★ Round 24 修复：`GF.fired`（释放计数）【不再每局清空】
  //   ⚠️ 用户报"这几个功法为啥准备就绪是0"——
  //      真因：功法其实每局放几十次，但 fired 被本函数清空
  //      ⇒ UI 读到的永远是 0 ⇒ 看起来"从没触发过"
  //   ⇒ 改为【跨局累计】（它本来就是统计量，不是每局状态）
  //      换代时由 newDisciple → gfResetAll() 清零
  GF.fired = GF.fired || {};
  for (const g of GONGFA) {
    if (g.modal !== "主动") continue;
    // ⚠️ init = 0（不是 -cdN）：
    //    gfOnSwing 先自增再检查 (swings − last) >= cdN
    //    ⇒ 第 cdN 次出手时 swings = cdN，(cdN − 0) >= cdN ✅
    //    ⇒ 第 1 次时 (1 − 0) >= cdN ❌（当 cdN > 1）
    if (g.cd === "swing") GF.lastSwing[g.id] = 0;
    else if (g.cd === "sec") GF.lastSec[g.id] = 0;
  }
  GF._releaseSoul = false;
}
// ★ 换代时清空释放计数（新一代弟子重新计数）
function gfResetAll() {
  GF.fired = {};
  GF.swings = 0;
  GF.killStack = 0; GF.speedStack = 0; GF.soul = 0;
}

// 心法/身法/攻伐/护体/秘术 的【属性修正】——playerStats 里调用
// ★ 功法修正（Round 12 改造：条件型 + 小额兜底 ≤5%）
//
// 改造依据（设计规格_功法改造方案.md）：
//   · 原设计有 7 条带【常驻数值】⇒ 违反"装备给常驻数值 / 功法给机制"的分工
//   · 改为：条件修正（战况驱动）+ 机制改写 + 【小额兜底】
//   · 兜底 ≤5%，且与词缀【共用】乘区预算（层2 §35 / §38）
function gfMods() {
  const m = { atk: 1, freq: 1, hp: 1, def: 1, evade: 0, thresh: 0, dmgTaken: 1, qi: 1 };
  const hpPct = G.hp / Math.max(1, G.hpMaxBase || 1);
  const st = G._lastSt;
  const threats = G.threats || 0;

  // ---- 心法 ----
  // 焚心诀：击杀累积攻击（停手 6 秒后层数减半 —— 让它不是"常驻"而是"要一直打"）
  if (gfOn('x_fashi')) m.atk *= 1 + P.GF_FASHI_PER_KILL * Math.min(GF.killStack, 12);
  // 吐纳术：停手后蓄势一击（伤害/目标数在出手处结算）+ 兜底
  if (gfOn('x_tuna')) m.atk *= 1 + 0.03;
  // 清心咒：血量 <40% 才开门；兜底减伤 3%
  if (gfOn('x_qingxin')) {
    m.dmgTaken *= 0.97;
    if (Math.min(1, G.hp / Math.max(1, G.hpMax || 1)) < 0.40) m.evade += P.GF_QINGXIN_EVADE;
  }

  // ---- 身法 ----
  // 追风步：击杀累积出手频率 + 兜底
  if (gfOn('s_zhuifeng')) {
    m.freq *= 1 + P.GF_ZHUIFENG_PER_STACK * Math.min(GF.speedStack, 6);
    m.freq *= 1.03;
  }
  // 凌波微步：闪避→提速的触发链（在出手处结算层数）+ 兜底闪避
  if (gfOn('s_lingbo')) m.evade += 0.03;

  // ---- 攻伐 ----
  // 破军式：被围时才强（但更脆）
  if (gfOn('g_po')) {
    m.atk *= 1.03;
    if (threats >= 3) { m.atk *= 1 + P.GF_POJUN_ATK; m.dmgTaken *= 1 + P.GF_POJUN_TAKEN; }
  }

  // ---- 护体 ----
  // 金刚体：受击后才抬阈值（响应式）；兜底减伤 3%
  if (gfOn('h_jingang')) {
    m.dmgTaken *= 0.97;
    if (G.hitT > 0) m.thresh += P.GF_JINGANG_THRESH;
  }
  // 龟息功：机制·永续（一条加成 + 一个真实代价，不再互相抵消）
  if (gfOn('h_guixi')) { m.dmgTaken *= 1 - P.GF_GUIXI_CUT; m.freq *= 1 - P.GF_GUIXI_FREQ; }

  // ---- 秘术 ----
  if (gfOn('m_lianqi')) m.qi *= 1.03;   // 兜底（主要效果是事件型：每 20 杀 +60 灵气）

  return m;
}

// 击杀事件：累积层数与魂力
function gfOnKill() {
  GF.killStack++;
  if (GF.killStack % 5 === 0) GF.speedStack++;
  if (gfOn('m_hunli')) {
    GF.soul++;
    if (GF.soul >= 100) { GF.soul = 0; GF._releaseSoul = true; }
  }
}

// ★ 功法掉落：击杀时小概率学会一本【尚未学会】的功法
//   用户要求："功法应该和装备一样掉落然后供玩家选择装备"
const GF_DROP_PER_KILL = 1 / 260;   // 约每 260 杀掉一本（一局约 3 本）
// ★ 功法作为【物品】掉进背包（用户要求：功法也该进背包，手动装）
//   注：后续会做"自动装备"，现在先手动（用户明确指定，便于测试）
function makeGongfaItem(id) {
  const g = GF_BY_ID[id];
  return {
    id: UID++, kind2: 'gongfa', gfId: id, q: 2,
    name: '功法·' + g.name, type: g.type,
    desc: g.desc, trigger: g.trigger, modal: g.modal,
    _new: true, _t: Date.now(),
  };
}
// ★ 法宝作为【物品】掉进背包
function makeFabaoItem(id) {
  const f = FABAO_BY_ID[id];
  return {
    id: UID++, kind2: 'fabao', fbId: id, q: 3,
    name: '法宝·' + f.name, wx: f.wx, sig: null,
    desc: f.desc, cond: f.cond, condN: f.condN, cost: f.cost,
    _new: true, _t: Date.now(),
  };
}
// 背包里是否已有某功法书 / 法宝
function bagHas(kind2, key) {
  return G.bag.some(it => it.kind2 === kind2 && (it.gfId === key || it.fbId === key));
}
// ★ 法宝掉落：约每 400 杀掉一件（比功法稀有）
const FB_DROP_PER_KILL = 1 / 400;
function rollFabaoDrop() {
  if (Math.random() >= FB_DROP_PER_KILL) return;
  // 池子 = 还没拥有 且 背包里还没有的
  const pool = FABAO.filter(f => !FB_OWNED[f.id] && !bagHas('fabao', f.id));
  if (pool.length === 0) return;
  const f = pool[Math.floor(Math.random() * pool.length)];
  const it = makeFabaoItem(f.id);
  G.bag.push(it);
  G.fbDropped = (G.fbDropped || 0) + 1;
  ev("fb_drop", 7, { name: f.name });
  // ★ Round 24：法宝也【掉到就装】（槽满则替换，具体见 autoPickSpecs）
  grantFabao(f.id);
  G.bag.splice(G.bag.indexOf(it), 1);
  log("✦ 获得法宝·" + f.name + "（" + f.wx + "）→ " +
    (FB.eq.indexOf(f.id) >= 0 ? '已装备' : '已入库'), "ok");
  try { autoPickSpecs(); } catch (e) {}     // 槽满时自动挑最合适的
  G.fx.push({ x: G.heroX, y: G.heroY - 0.20, txt: "法宝 " + f.name, cls: "crit", life: 1 });
}
function rollGongfaDrop() {
  if (Math.random() >= GF_DROP_PER_KILL) return;
  // 池子 = 还没学会 且 背包里还没有的
  const pool = GONGFA.filter(g => !GF_KNOWN[g.id] && !bagHas('gongfa', g.id));
  if (pool.length === 0) return;
  const g = pool[Math.floor(Math.random() * pool.length)];
  // ★ Round 24（用户要求）：掉到就【立刻参悟】
  //   ⚠️ 但★【只在槽位为空时自动装】★ —— 绝不覆盖玩家手动选过的
  //   用户原话："功法改一掉就装，然后等后面掉落了其他的功法就选合适自己的"
  //   ⇒ 掉落=学会并填空；玩家手动选择=最终的（自动不再改）
  G.gfDropped = (G.gfDropped || 0) + 1;
  ev("gf_drop", 6, { name: g.name, type: g.type });
  GF_KNOWN[g.id] = true;                      // 学会
  // ★ Round 31（用户："功法不要学了不用，要学了就用"）
  //   ⇒ 不再"只在空槽时装"，改为【每次学会都重新挑一遍最强的】
  //     未锁的槽位会立刻用上更强的；玩家手动锁的槽位保持不动
  autoPickGongfa();
  G.fx.push({ x: G.heroX, y: G.heroY - 0.18, txt: "功法 " + g.name, cls: "crit", life: 1 });
}


// 一次出手结算（周期型/释放型）
//   冲突仲裁：同一刻度最多 1 个"占出手"效果（裂空斩优先于天雷引）
// ★ 主动技能的冷却与仲裁（Round 12 · 设计规格_功法主动技能方案.md）
//
// 三条规则：
//   ① 冷却驱动：cd='swing' 按出手数（与攻速咬合）· cd='sec' 按游戏秒（受 CDR 缩放）
//   ② 反刷屏：同一刻度【最多释放 1 个主动技能】
//   ③ 能动性：多件就绪时按【玩家预设的优先级】取第一个
//
// ⚠️ 冷却缩减（CDR）只作用于 cd='sec'，不作用于 cd='swing'
//    （否则出手频率会同时放大"基础 DPS"和"技能频率"，正反馈过强）
function gfActiveList() {
  return GONGFA.filter(g => g.modal === '主动' && gfOn(g.id));
}
// 玩家优先级（可拖拽/点击调整）；未设置的补到末尾
function gfPriority() {
  const act = gfActiveList().map(g => g.id);
  const p = (GF.prio || []).filter(id => act.indexOf(id) >= 0);
  for (const id of act) if (p.indexOf(id) < 0) p.push(id);
  GF.prio = p;
  return p;
}
function gfMovePrio(id, dir) {
  const p = gfPriority();
  const i = p.indexOf(id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= p.length) return;
  const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  GF.prio = p;
}
// 冷却是否就绪
function gfReady(g) {
  const cdr = 1 - Math.min(P.CDR_CAP, G.cdr || 0);   // 只影响 'sec'
  if (g.cd === 'swing') {
    // ⚠️ 不能用 `|| -1e9`：lastSwing 的合法值包含 0（开局时刻），
    //    而 0 是假值 ⇒ 会走兜底 -1e9 ⇒ (0 − (−1e9)) = 1e9 ⇒ 永远就绪
    const last = GF.lastSwing[g.id];
    if (last === undefined) return false;              // 从未初始化 ⇒ 不就绪
    return (GF.swingW - last) >= g.cdN;   // ★ R61：加权出手数（节拍无关）
  }
  if (g.cd === 'sec') {
    const lastS = GF.lastSec[g.id];
    if (lastS === undefined) return false;
    return ((G.t || 0) - lastS) >= Math.max(0.1, g.cdN * cdr);
  }
  if (g.cd === 'run') return !GF.usedRun[g.id];
  return false;
}
function gfMarkUsed(g) {
  GF.fired[g.id] = (GF.fired[g.id] || 0) + 1;   // ★ 释放计数
  if (g.cd === 'swing') GF.lastSwing[g.id] = GF.swingW;   // ★ R61：加权出手数
  else if (g.cd === 'sec') GF.lastSec[g.id] = G.t || 0;
  else if (g.cd === 'run') GF.usedRun[g.id] = 1;
}

// 一次出手结算：按优先级取【第一个就绪】的主动技能
function gfOnSwing() {
  GF.swings++;
  // ★ R61：加权出手数（每次出手 +CADENCE）—— 所有按【出手次数】计的阈值都改用它，
  //   这样节拍拉长后『每 N 次出手』的等效时长自动不变，不需要逐个改功法的 cdN
  GF.swingW = (GF.swingW || 0) + P.CADENCE;
  // ★ R61 顺带修：凌波微步的『闪避后 3 次出手提速』**从来没有被递减过** ⇒
  //   实际成了一次触发、永久生效。这里补上递减（按加权单位，等效时长与旧版一致）
  if (GF.lingboT > 0) GF.lingboT -= P.CADENCE;
  // ★ 缩地成寸：必暴窗口递减（本次出手消耗 1 次）
  if (GF.critWindow > 0) GF.critWindow--;
  const out = { burst: null, qi: 0, heal: 0, extraTargets: 0, fired: null, firedName: null,
    guarCrit: 0, shield: 0, shieldT: 0, shieldCut: 0 };
  const st = G._lastSt || {};
  const threats = G.threats || 0;
  // ⚠️ 必须用 G.hpMax（本局的钳制基准），不能用 st.hp：
  //    st.hp 含功法/词缀加成，通常【高于】G.hpMax ⇒ G.hp/st.hp 恒 <1 且恒接近 1
  //    ⇒ 实测 hpPct 恒等于 1.000 ⇒ 所有"低血"条件功法永不触发
  const hpPct = Math.min(1, G.hp / Math.max(1, G.hpMax || st.hp || 1));

  for (const id of gfPriority()) {
    const g = GF_BY_ID[id];
    if (!g || !gfReady(g)) continue;
    // 各技能自身的触发条件
    if (id === 'm_hunli' && GF.soul < 100) continue;
    if (id === 'x_qingxin' && hpPct >= 0.40) continue;          // 保命类：只在低血开
    if (id === 'x_ningshen' && hpPct >= 0.30) continue;         // ★ 凝神归元：只在更低血开
    if (id === 'h_jingang' && !(G.hitT > 0)) continue;          // 响应类：只在受击后
    // ★ 金钟罩："刚受击 或 低血" 才开门（响应式保命）
    //   ⚠️ 两版都错了：
    //     ① 用"超压"判定 ⇒ 护盾挡住血后 hp 恒满而威胁恒超压 ⇒ 覆盖率 96% ⇒ 近乎无敌
    //     ② 只用"血量 <60%" ⇒ 实测档 24 从满血直落到底，从不经过该阈值 ⇒ 从不释放
    //   ⇒ 改为【受击响应 + 低血】双条件
    if (id === 'h_jinzhong' && !(G.hitT > 0 || hpPct < 0.60)) continue;
    // ---- 生效 ----
    else if (id === 'g_zhan') out.burst = { mul: 2.2, extra: 4, name: '裂空斩' };
    else if (id === 'g_lei') out.burst = { mul: 1.8, extra: 10, name: '天雷引' };
    else if (id === 'h_huichun') out.heal = 0.04;
    else if (id === 'm_juxian') out.qi = 40;
    else if (id === 'm_hunli') { out.burst = { mul: 3.0, extra: 99, name: '魂力爆发' }; GF.soul = 0; }
    else if (id === 'x_qingxin') { out.evadeBoost = P.GF_QINGXIN_EVADE; }
    else if (id === 'h_jingang') { out.threshBoost = P.GF_JINGANG_THRESH; }
    // ★ 新增 4 条
    else if (id === 'x_ningshen') { out.heal = P.GF_NINGSHEN_HEAL; out.shieldT = P.GF_NINGSHEN_SEC; out.shieldCut = P.GF_NINGSHEN_CUT; }
    else if (id === 's_suodi') { out.guarCrit = P.GF_SUODI_WINDOW; out.extraTargets += P.GF_SUODI_AOE; }
    else if (id === 'g_wanjian') { out.burst = { mul: P.GF_WANJIAN_MUL, extra: 999, name: '万剑归宗' }; }
    else if (id === 'h_jinzhong') { out.shield = P.GF_JINZHONG_SHIELD; out.shieldT = P.GF_JINZHONG_SEC; }
    gfMarkUsed(g);
    // ★ 缩地成寸：必暴窗口立即生效（写在触发处，不是 step 里）
    if (out.guarCrit > 0) GF.critWindow = out.guarCrit;
    out.fired = id;
    // ★ R62：特效需要名字（不只是 id）—— 释放时给玩家看的是"裂空斩"不是"g_zhan"
    try { out.firedName = (GF_BY_ID[id] || {}).name || id; } catch (e) { out.firedName = id; }
    break;   // ★ 同一刻度最多 1 个主动技能
  }
  return out;
}

// ---------------- 三之二·二十五、宝库处置策略（Round 27）----------------
//
// 用户原话：
//   "然后贡献值就不要了，神话装备传奇装备传承到宝库，可以由玩家来决定
//    到底是当素材，还是给后面的弟子用，又或者当耗材分解，
//    当然玩家不在的时候就根据玩家留下的指示来判断"
//
// 设计：
//   弟子结束 ⇒ 卡槽内的（3~6 件）直传给下一代
//   其余全部进【宝库】
//   宝库里的每一件，按【玩家留下的策略】自动处置：
//
//     ┌─ 传家  → 留在宝库，等后人取用（现有 pullFromPool）
//     ├─ 素材  → 拆成【宗门素材】（喂锻造）
//     ├─ 荣誉  → 换成【荣誉点】（宗门升级用）
//     └─ 保留  → 不动（玩家回来再说）
//
//   ★ 关键：策略是【按档位分段】的 —— 神话和传奇可以有不同策略
//     （用户："神话装备传奇装备传承到宝库" ⇒ 这两档才值得管）
//
//   ★ 单件覆盖：玩家可对某一件单独指定（优先于策略）

const VAULT = {
  // 策略：按品质档给一个"默认处置"
  //   keep = 传家 · mat = 拆素材 · honor = 换荣誉 · hold = 保留不动
  policy: {
    4: 'keep',    // 神话：默认传家
    3: 'keep',    // 传奇：默认传家
    2: 'mat',     // 史诗：默认拆素材
    1: 'mat',     // 精良：默认拆素材
    0: 'mat',     // 普通：默认拆素材
  },
  // 单件覆盖 { [itemId]: 'keep'|'mat'|'honor'|'hold' }
  override: {},
  // 统计（挂机报告用）
  stat: { keep: 0, mat: 0, honor: 0, hold: 0 },
};
const VAULT_MODES = [
  { id: 'keep',  name: '传家',  desc: '留在宝库，等后人取用' },
  { id: 'mat',   name: '拆素材', desc: '拆成宗门素材（喂锻造）' },
  { id: 'honor', name: '换荣誉', desc: '换成荣誉点（宗门升级）' },
  { id: 'hold',  name: '保留',  desc: '不动，等玩家回来决定' },
];
const VAULT_MODE_BY_ID = {};
VAULT_MODES.forEach(m => { VAULT_MODE_BY_ID[m.id] = m; });

// 某件在宝库里的处置方式（覆盖 > 策略）
function vaultModeFor(it) {
  if (VAULT.override[it.id]) return VAULT.override[it.id];
  const p = VAULT.policy[it.q | 0];
  return p || 'hold';
}
// 拆素材的价值（比直接分解高一点，因为经过宝库"精炼"）
function vaultMatValue(it) {
  return Math.round(disenchantValue(it) * 1.25);
}
// 换荣誉的价值
function vaultHonorValue(it) {
  return Math.max(1, Math.round((it.q | 0) * 3 + (it.ilvl || 1) * 0.06));
}

// ---- 结算宝库（弟子结束时调用；也用于挂机补齐）----
function vaultSettle() {
  const pool = SECT.legacyPool;
  if (!pool.length) return { keep: 0, mat: 0, honor: 0, hold: 0, mats: 0, honorGot: 0 };
  const out = { keep: 0, mat: 0, honor: 0, hold: 0, mats: 0, honorGot: 0 };
  for (let i = pool.length - 1; i >= 0; i--) {
    const it = pool[i];
    const mode = vaultModeFor(it);
    if (mode === 'keep') { out.keep++; continue; }
    if (mode === 'hold') { out.hold++; continue; }
    if (mode === 'mat') {
      out.mats += vaultMatValue(it);
      out.mat++;
    } else if (mode === 'honor') {
      out.honorGot += vaultHonorValue(it);
      out.honor++;
    }
    pool.splice(i, 1);
  }
  if (out.mats) SECT_RES.materials += out.mats;
  if (out.honorGot) SECT.honor += out.honorGot;
  VAULT.stat.keep += out.keep; VAULT.stat.mat += out.mat;
  VAULT.stat.honor += out.honor; VAULT.stat.hold += out.hold;
  if (out.mat || out.honor) {
    log('✦ 宝库处置：' + (out.mat ? '拆素材 ' + out.mat + ' 件(+' + out.mats + ')' : '') +
      (out.mat && out.honor ? ' · ' : '') +
      (out.honor ? '换荣誉 ' + out.honor + ' 件(+' + out.honorGot + ')' : ''), 'sys');
    ev('vault_settle', 6, out);
  }
  return out;
}

// ---------------- 三之二·二十四、单挑（Boss / PVP 共用 · Round 26）----------------
//
// 用户需求（Round 26）：
//   "1.boss独立一段吧  2.自动结算能看见过程  3.肯定是动画和演出啊，
//    这两个才能把单纯的血条对撞变成活的，两方有来有回，你攻我闪之类的肯定很爽啊。
//    4.对的，打boss和pvp应该是差不多的，已经现在这套清怪的应该可以直接用来pvp单挑吧"
//   "6.随境界吧1%-12%"  "3.失败了不就是被打死了吗当战死呗"
//
// 架构（用户确认）：
//   跑图段（现有 step）  →  单挑段（本模块）  →  结算
//   单挑与 PVP 共用同一套结算器，区别只在"对手来源"：
//     Boss 模式 ⇒ AI 招式循环
//     PVP  模式 ⇒ 对手快照
//
// ⚠️ 与"清怪"的本质差异（不能直接复用清怪逻辑）：
//   清怪：对群 · 承压阈值 · AOE 关键 · 击杀数达标
//   单挑：对单 · 单次大伤害 · 破防/暴击关键 · 打光血条
//   ⇒ 数值层复用（六乘区/相性/同调），【战斗流程】新写

const DUEL = {
  active: false,
  phase: 'idle',        // idle / boss / pvp / done
  t: 0,                 // 单挑已进行秒数
  limit: 55,            // 单挑时长上限（用户：45~60 秒）
  me: null,             // { hp, hpMax, atk, def, ... }
  foe: null,            // { name, hp, hpMax, atk, pattern, ... }
  meCd: 0,              // 我方下次出手
  foeCd: 0,             // 对方下次出手
  log: [],              // 动作事件流（供演出层逐条播放）
  result: null,         // 'win' / 'lose' / 'timeout'
  verdict: null,        // 详细判定（给报告）
};

// ---- Boss 定义（数值 + 机制 · 机制可被数值碾过去 = E3 原则）----
const BOSS_DEFS = [
  { id: 'b_kuang', name: '狂骨魔君', wx: '金',
    hpMul: 26, atkMul: 1.55, freq: 0.55,
    pattern: ['蓄力', '爆发', '硬直'], desc: '每 3 招一次爆发（可被打断）' },
  { id: 'b_yan', name: '炎狱妖尊', wx: '火',
    hpMul: 24, atkMul: 1.45, freq: 0.62,
    pattern: ['灼烧', '连击', '连击'], desc: '连击时伤害递减' },
  { id: 'b_xuan', name: '玄水蛟皇', wx: '水',
    hpMul: 30, atkMul: 1.28, freq: 0.48,
    pattern: ['凝滞', '蓄力', '回复'], desc: '会回血（打断可止）' },
  { id: 'b_qing', name: '青木妖王', wx: '木',
    hpMul: 28, atkMul: 1.35, freq: 0.52,
    pattern: ['缠绕', '爆发', '硬化'], desc: '硬化时减伤（等它结束）' },
  { id: 'b_hou', name: '厚土岳神', wx: '土',
    hpMul: 34, atkMul: 1.20, freq: 0.42,
    pattern: ['震地', '硬化', '震地'], desc: '血厚攻低，磨' },
];

// 按秘境倾向挑 Boss（与秘境属性匹配 ⇒ 与玩家相性互动）
function pickBoss() {
  const zb = (typeof zbNow === 'function') ? zbNow() : null;
  if (zb && zb.wx) {
    const hit = BOSS_DEFS.filter(b => b.wx === zb.wx);
    if (hit.length) return hit[Math.floor(Math.random() * hit.length)];
  }
  return BOSS_DEFS[Math.floor(Math.random() * BOSS_DEFS.length)];
}

// ---- 进入单挑段 ----
// ---- 进入单挑段 ----
//
// ★★ 数值校准（Round 26 · 用【单挑】自己的口径，不沿用群怪）
//
//   群怪的难度口径是「承压 = 危险值 × 圈内怪数 /秒」，那是按【一群】设计的。
//   单挑是 1v1 ⇒ 必须换算成"单次大伤害"。
//   实测参考（一身合适品质）：
//     档1  玩家 atk 158 · hp 1593 · 小怪 hp 107（2 刀）
//     档9  玩家 atk 456 · hp 4211 · 小怪 hp 284（2 刀）
//     档17 玩家 atk 1718 · hp 13076 · 小怪 hp 756（1 刀）
//
//   目标（用户：45~60 秒 + 数值与机制的碰撞）：
//     · Boss 约需 34 刀击杀（有来有回，不是秒杀）
//     · Boss 每刀打掉玩家约 32% 生命（约 3 刀 + 闪避/回复 ⇒ 撑 40~55 秒）
function duelStartBoss() {
  const st = playerStats();
  const boss = pickBoss();
  const _d = dmgMul(P.DEF_ANCHOR);
  const meAtkEff = st.atk * _d;
  DUEL.active = true;
  DUEL.phase = 'boss';
  DUEL.t = 0;
  DUEL.log = [];
  DUEL.result = null;
  DUEL.me = { name: '弟子', hp: G.hp, hpMax: st.hp, atk: st.atk, def: st.def, wx: st.wuxing };
  const _hpBase = meAtkEff * 113 * (boss.hpMul / 26);   // 113 刀 ≈ 40 秒（Boss 打玩家 45 秒）
  DUEL.foe = {
    id: boss.id, name: boss.name, wx: boss.wx,
    hp: _hpBase, hpMax: _hpBase,
    def: P.DEF_ANCHOR,
    atk: st.hp * 0.12 * (boss.atkMul / 1.35),   // 每刀 12% 生命 ⇒ 约 45 秒打死玩家
    freq: boss.freq,
    pattern: boss.pattern.slice(),
    step: 0,
    buff: null,
    desc: boss.desc,
  };
  DUEL.meCd = 1 / Math.max(0.1, (st.actFreq || 3));
  DUEL.foeCd = 1 / Math.max(0.1, boss.freq);
  duelPush('sys', '⚔ ' + boss.name + ' 现身！' + boss.desc);
  return DUEL;
}

// ---- 动作事件（供演出层播放）----
function duelPush(kind, text, extra) {
  DUEL.log.push(Object.assign({ kind: kind, text: text, t: DUEL.t }, extra || {}));
  if (DUEL.log.length > 60) DUEL.log.shift();
  // ★★ 演出队列（Round 28）：前端按队列逐条播放，而不是每帧重画
  //   为什么要独立队列：DUEL.log 是"数据"（可能一帧生成多条），
  //   而演出必须【一条一条播】才有"回合感"
  DUEL.fx.push(Object.assign({ kind: kind, text: text, age: 0 }, extra || {}));
  if (DUEL.fx.length > 24) DUEL.fx.shift();
  DUEL.pending++;
}

// ---- 单挑结算（每次推进一步）----
function duelStep(dt) {
  if (!DUEL.active) return;
  // ★ 演出层：把队列里的事件按时长推进（每条 0.45 秒）
  for (let i = DUEL.fx.length - 1; i >= 0; i--) {
    DUEL.fx[i].age += dt;
    if (DUEL.fx[i].age > 1.6) DUEL.fx.splice(i, 1);
  }
  if (DUEL.anim) { DUEL.anim.age += dt; if (DUEL.anim.age > 0.5) DUEL.anim = null; }
  // ★ 演出未播完 ⇒ 暂停战斗推进（否则一帧出 5 招，看不出"回合"）
  if (DUEL.pending > 0) {
    DUEL.pending -= dt / 0.45;
    if (DUEL.pending < 0) DUEL.pending = 0;
    return;
  }
  DUEL.t += dt;
  const me = DUEL.me, foe = DUEL.foe;

  // 双方按各自的出手间隔交替出招
  DUEL.meCd -= dt;
  DUEL.foeCd -= dt;

  if (DUEL.meCd <= 0) {
    DUEL.meCd += 1 / Math.max(0.1, (playerStats().actFreq || 3));
    DUEL.anim = { who: 'me', type: 'attack', age: 0 };
    // —— 我方出手 ——
    //   对方可能有：闪避 / 格挡 / 硬吃
    const fRoll = Math.random();
    const foeDodge = 0.10, foeBlock = 0.12;
    if (foe.buff === '硬化') {
      const d = me.atk * dmgMul(foe.def) * 0.45;
      foe.hp -= d;
      duelPush('myhit', '击中（硬化减伤） -' + Math.round(d), { dmg: d, cls: 'weak' });
    } else if (fRoll < foeDodge) {
      duelPush('myhit', foe.name + ' 闪避！', { dmg: 0, cls: 'dodge' });
    } else if (fRoll < foeDodge + foeBlock) {
      const d = me.atk * dmgMul(foe.def) * 0.55;
      foe.hp -= d;
      duelPush('myhit', '被格挡 -' + Math.round(d), { dmg: d, cls: 'weak' });
    } else {
      const crit = Math.random() < (stCritRate());
      let d = me.atk * dmgMul(foe.def) * (crit ? 1.6 : 1.0);
      foe.hp -= d;
      duelPush('myhit', (crit ? '暴击！' : '命中') + ' -' + Math.round(d),
        { dmg: d, cls: crit ? 'crit' : '' });
    }
    if (foe.hp <= 0) { duelFinish('win'); return; }
  }

  if (DUEL.foeCd <= 0) {
    DUEL.foeCd += 1 / Math.max(0.1, foe.freq);
    DUEL.anim = { who: 'foe', type: 'attack', age: 0 };
    // —— 对方出手（招式循环）——
    const mv = foe.pattern[foe.step % foe.pattern.length];
    foe.step++;
    let mul = 1.0, note = '';
    if (mv === '蓄力') { foe.buff = '蓄力'; mul = 0; note = '开始蓄力…'; }
    else if (mv === '爆发') { mul = 2.2; foe.buff = null; note = '爆发！'; }
    else if (mv === '硬化') { foe.buff = '硬化'; mul = 0; note = '硬化（减伤）'; }
    else if (mv === '回复') { foe.buff = null; const heal = foe.hpMax * 0.06; foe.hp = Math.min(foe.hpMax, foe.hp + heal); note = '回复 +' + Math.round(heal); }
    else if (mv === '连击') { mul = 1.25; foe.buff = null; note = '连击'; }
    else if (mv === '缠绕') { mul = 0.8; foe.buff = null; note = '缠绕'; }
    else if (mv === '灼烧') { mul = 1.1; foe.buff = null; note = '灼烧'; }
    else if (mv === '震地') { mul = 1.35; foe.buff = null; note = '震地'; }
    else if (mv === '凝滞') { mul = 0.9; foe.buff = null; note = '凝滞'; }
    if (mul > 0) {
      // 我方可能闪避
      const st2 = playerStats();
      const myEvade = st2.evade || 0;
      if (Math.random() < myEvade * 0.55) {          // 单挑里闪避打折（不能无敌）
        duelPush('foehit', '我闪避了 ' + foe.name + ' 的' + mv, { dmg: 0, cls: 'dodge' });
      } else {
        const d = foe.atk * mul;
        me.hp -= d;
        duelPush('foehit', foe.name + ' 的' + mv + ' -' + Math.round(d),
          { dmg: d, cls: mul >= 2 ? 'crit' : '' });
      }
    } else if (note) {
      duelPush('sys', foe.name + ' ' + note);
    }
    if (me.hp <= 0) { duelFinish('lose'); return; }
  }

  if (DUEL.t >= DUEL.limit) { duelFinish('timeout'); return; }
}

// 暴击率（从玩家属性取，缺省 0）
function stCritRate() {
  const st = playerStats();
  return Math.max(0, Math.min(0.6, st.crit || 0));
}

// ---- 收尾判定 ----
function duelFinish(result) {
  // ★ 单挑结束 ⇒ 回到局结算（胜=通关，负=战死，超时=击退未竟）
  setTimeout(function () {
    if (typeof endRun === 'function' && G.running) endRun(result === 'win');
  }, 600);
  DUEL.active = false;
  DUEL.phase = 'done';
  DUEL.result = result;
  const foe = DUEL.foe, me = DUEL.me;
  const foePct = Math.max(0, foe.hp / Math.max(1, foe.hpMax));
  const mePct = Math.max(0, me.hp / Math.max(1, me.hpMax));
  DUEL.verdict = {
    result: result,
    foeLeftPct: foePct, meLeftPct: mePct,
    // 用户："失败了不就是被打死了吗当战死呗"
    died: result === 'lose',
    // 超时算"击退未竟"：不战死，但也不给通关
    repelled: result === 'timeout',
  };
  if (result === 'win') duelPush('sys', '★ ' + foe.name + ' 被斩落！');
  else if (result === 'lose') duelPush('bad', '💀 弟子倒于 ' + foe.name + ' 之手…');
  else duelPush('sys', '⏱ ' + foe.name + ' 仍在（击退未竟）');
  // 把我方剩余血量写回局内（阵亡则 0）
  G.hp = result === 'lose' ? 0 : Math.max(1, Math.round(me.hp));
  return DUEL.verdict;
}

function duelReset() {
  DUEL.fx = []; DUEL.pending = 0; DUEL.anim = null;
  DUEL.active = false; DUEL.phase = 'idle'; DUEL.t = 0;
  DUEL.me = null; DUEL.foe = null; DUEL.log = []; DUEL.result = null; DUEL.verdict = null;
}

// ---------------- 三之二·九、属性同调（计数制 · 六乘区之一）----------------
//
// 设计依据（属性同调.md §3 + 层2数值.md §12）：
//   同调值 = Σ同源×1 + Σ相生×1 − Σ相克×1  （+ Σ同源签名×2，词缀未实装）
//     · 标签池 = 11 个装备槽（**法宝不参与同调** —— 这是法宝独立成系统的原因）
//     · 相生两个方向都算（主生标签 / 标签生主）
//     · 纯同源上限 11 分；满级(13) 必须"全身同源 + 一件同源签名"
//   等级：0:<0(×0.94) 1:≥2(×1.03) 2:≥5(×1.06) 3:≥8(×1.10) 4:≥10(×1.15) 5:≥13(×1.22)
const TD_THRESH = [2, 5, 8, 10, 13];
const TD_MUL = [0.94, 1.03, 1.06, 1.10, 1.15, 1.22];

// 单件装备的标签属性（★ 固定映射，不是随机分配）
//
// ⚠️ 初版用 hash 派生 ⇒ 五行分布极不均（土 0 个、木 5 个），
//    「11 部位全身同源」根本达不到 ⇒ 同调等级 5 永远无法达成，设计意图落空。
//    现改为【固定表】，让五行在 11 部位上均匀铺开（每行 2~3 个）。
//    主手的标签 = 武器的五行，与"主属性来自武器"保持一致。
const SLOT_WUXING = {
  '主手': null,        // 跟随武器（主属性本身）
  '副手': '金', '项链': '金',
  '头': '木', '胸': '木', '腰': '木',
  '肩': '水', '戒指': '水',
  '手': '火', '腿': '火',
  '足': '土', '腰2': '土',
};
// ★ 装备的五行 = 【掉落时随机】，是装备自身的属性
//
//   ⚠️ 初版把五行做成"部位固定" ⇒ 同源最多只有 3 个
//      ⇒ 文档算的"11 部位全身同源 = 11 分"根本不可能，同调等级 3+ 永远达不到。
//   改为装备属性后：
//      · 玩家可以【去刷同源的装备】来堆同调 ⇒ 这才是"属性同调"的乐趣
//      ⇒ 也让掉落多了一个筛选维度（复用已有的三层筛选）
function rollWuxing() { return WUXING[Math.floor(Math.random() * 5)]; }
// 单件装备的标签五行 = 它自己的 wx（掉落生成时已写入；主手/副手写入的是武器五行）
//   全部 11 槽统一按此取值 ⇒ 不再特判主手，也保证副手双持时各自带自己的五行
function slotWuxing(slot, item) {
  if (!item) return null;
  if (item.wx) return item.wx;
  // ★ Round 16：武器不再兜底成固定五行（武器属性由 wx 决定）
  return rollWuxing();   // 老存档兜底：没 wx 就现滚一个
}

// 同调伤害倍率（供伤害结算直接调用）
function tdMul(mainEl) { return tdValue(mainEl).mul; }

// 标签相对主属性的得分：同源+1 · 相生+1 · 相克−1 · 无关 0
function tdScoreFor(labelEl, mainEl) {
  if (!labelEl || !mainEl) return 0;
  if (labelEl === mainEl) return 1;
  if (SHENG[mainEl] === labelEl) return 1;
  if (SHENG[labelEl] === mainEl) return 1;
  if (KE[mainEl] === labelEl) return -1;
  if (KE[labelEl] === mainEl) return -1;
  return 0;
}

function tdValue(mainEl) {
  let v = 0, same = 0, sheng = 0, ke = 0, n = 0;
  if (mainEl) {
    for (const z of Object.keys(G.zones)) {
      const zc = G.zones[z];
      for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
        const c = zc.cells[y][x];
        if (!c || !c._anchor) continue;          // 只数锚点格（一件装备算一次）
        const labelEl = slotWuxing(c.slot, c);
        const s = tdScoreFor(labelEl, mainEl);
        if (labelEl === mainEl) same++;
        else if (s > 0) sheng++;
        else if (s < 0) ke++;
        v += s; n++;
      }
    }
  }
  // ★ 神话签名词缀：同源签名【加权 ×2】
  //   （属性同调.md §3.4：11 同源 + 1 同源签名 = 13 ⇒ 等级 5）
  let signBonus = 0;
  if (mainEl) {
    for (const x of equippedSignatures(mainEl)) {
      if (x.same) { signBonus += SIGN_SAME_BONUS; v += SIGN_SAME_BONUS; }
    }
  }
  // ⚠️ 等级 0 = 惩罚（×0.94）只在【同调值为负】时生效；
  //    v 在 [0,2) 之间是"无加成也无惩罚"⇒ 用 level = -1 表示
  // ★ 灵根调整同调门槛（Round 14）：多灵根门槛低 ⇒ 同调等级更容易上去
  //   单灵根 ×1.00（最严）· 四灵根 ×0.78 · 五灵根 ×0.70（最松）
  const lgTm = lgTdThreshMul();
  let level = -1;
  for (let i = 0; i < TD_THRESH.length; i++) {
    if (v >= TD_THRESH[i] * lgTm) level = i + 1;
  }
  const mul = level < 0 ? (v < 0 ? TD_MUL[0] : 1.00) : TD_MUL[level];
  return { value: v, level: level < 0 ? 0 : level, neutral: level < 0 && v >= 0,
    same, sheng, ke, n, signBonus, mul };
}

// ---------------- 三之二·十二、神话签名词缀（同调等级 5 的钥匙）----------------
//
// 设计依据（属性同调.md §3.4 / 装备与掉落.md §3.3）：
//   · 仅【神话】品质自带，一件恰好 1 条，【不可重铸、不可转移】
//   · 本质 = 物品的【身份】+ 收集目标（不是"更强的数值"）
//   · 五行标签【加权 ×2】参与同调计分
//     ⇒ 11 件同源（11 分）+ 1 件同源签名（+2）= 13 ⇒ 等级 5
//   · 必须是【数值/条件型效果】，不做规则改写（规则改写只属于功法）
//
// ⚠️ 为了让"同调等级 5"在本引擎里真正可达，先修了 zoneRect：
//    原来 头/背/手臂/双腿 的网格被硬编码成 2×2 不随容量扩，
//    导致高档时【头只能放 1 件、双腿只能放 1 件】⇒ 11 部位装不下。
const SIGNATURES = [
  { id:'S1', wx:'金', name:'庚金·锋锐', desc:'对木属性敌人伤害 +15%',
    comment:'金克木 ⇒ 强化本命克制' },
  { id:'S2', wx:'木', name:'青木·生发', desc:'对土属性敌人伤害 +15%，每秒回血 +1%',
    comment:'木克土 + 木主生发' },
  { id:'S3', wx:'水', name:'玄水·凝滞', desc:'对火属性敌人伤害 +15%，受击伤害 −8%',
    comment:'水克火 + 水主守' },
  { id:'S4', wx:'火', name:'离火·焚尽', desc:'对金属性敌人伤害 +15%，暴击伤害 +12%',
    comment:'火克金 + 火主爆烈' },
  { id:'S5', wx:'土', name:'戊土·厚重', desc:'对水属性敌人伤害 +15%，承压阈值 +1',
    comment:'土克水 + 土主厚重' },
];
const SIGNATURE_BY_ID = {};
SIGNATURES.forEach(s => SIGNATURE_BY_ID[s.id] = s);
// 同源签名的同调加权
const SIGN_SAME_BONUS = 2;
// 签名的基础效果数值
const SIGN_KE_BONUS = 0.15;     // 对本命克制属性的敌人 +15%
const SIGN_HEAL_RATE = 0.01;    // 每秒回血 +1%（S2）
const SIGN_TAKEN_MUL = 0.92;    // 受击 ×0.92（S3）
const SIGN_CRIT_BONUS = 0.12;   // 暴击伤害 +12%（S4）
const SIGN_THRESH_ADD = 1;      // 承压阈值 +1（S5）

// 抽一个签名（五行由随机决定 ⇒ 你要"同源"就得去刷对应五行的那件）
function rollSignature() {
  return SIGNATURES[Math.floor(Math.random() * SIGNATURES.length)].id;
}

// ---------------- 神话装备命名池（q=4 专属威名 · 2026-10-15）----------------
//   设计依据：叙事层文案库_待审.md §十三。
//   9 个防具/首饰部位 + 5 类武器各一个池；武器按【实际武器类型】取名。
const MYTH_SLOT_NAMES = {
  '头':   ['紫金冠', '步云冠', '凌霄冠', '澄心笠', '镇魂冠', '鎏金冠'],
  '项链': ['定魂珠', '避水珠', '九窍珠', '龙涎链', '月华珠', '锁灵珠'],
  '肩':   ['披云肩', '铁骨肩', '镇岳肩', '星河披', '寒山肩', '玄魄肩'],
  '胸':   ['玄龟甲', '天蚕衣', '紫霞衣', '锁子甲', '不动甲', '云鹤袍'],
  '腰':   ['盘龙带', '束灵带', '玄武束', '伏魔带', '吞云带', '锁元带'],
  '手':   ['擒龙手', '裂石手', '玄冰腕', '摘星手', '缚虎腕', '碎岩手'],
  '戒指': ['定颜戒', '乾坤戒', '须弥戒', '轮回环', '无相戒', '太虚戒'],
  '腿':   ['追风护腿', '踏雪护腿', '斩棘护腿', '疾风护腿', '陷阵护腿', '逐日护腿'],
  '足':   ['踏云靴', '焚天靴', '玄龟履', '凌波履', '追日靴', '九霄靴'],
};
const MYTH_WEAPON_NAMES = {
  sword: ['承影', '含光', '龙渊', '太阿', '湛卢', '纯钧'],
  blade: ['断岳', '偃月', '昆吾', '龙雀', '斩风', '血饮'],
  spear: ['沥泉', '破军', '蟠龙', '点星', '断魂', '飞云'],
  bow:   ['射日', '落雁', '惊弦', '天狼', '穿云', '裂空'],
  staff: ['玄机', '定海', '盘龙', '枯荣', '引魂', '问天'],
};
// 抽一个神话威名（武器按实际武器类型取池，避免"剑用刀名"）
function rollMythName(slot, weaponId) {
  const arr = (slot === '主手' || slot === '副手')
    ? MYTH_WEAPON_NAMES[weaponId] : MYTH_SLOT_NAMES[slot];
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
// 当前装备里的签名单（0 或 1 件，因为只有 1 件神话时才可能有；
// 多件神话时取【与主属性同源】的那件为有效签名）
function equippedSignatures(mainEl) {
  const out = [];
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (!c || !c._anchor || !c.sig) continue;
      const s = SIGNATURE_BY_ID[c.sig];
      if (s) out.push({ item: c, sig: s, same: !!mainEl && s.wx === mainEl });
    }
  }
  return out;
}
// 当前生效的签名效果（只取第一个"同源"的；没有同源则取第一个）
function activeSignature(mainEl) {
  const list = equippedSignatures(mainEl);
  if (!list.length) return null;
  return (list.find(x => x.same) || list[0]).sig;
}

// ---------------- 三之二·十、法宝（玩家主动支配的战术事件）----------------
//
// 设计依据（法宝系统.md）：
//   · 独立于 11 装备槽（最多 3 个）；【不提供常驻数值】、【不参与同调】
//   · 有五行属性，只用于"相性"不用于同调
//   · 定位：功法 = "我平时怎么打"；法宝 = "我什么时候掀底牌"
//   · 玩家【预设触发条件】，满足时消耗【本源】自动催动（每局 1 次）
const FABAO = [
  { id: 'f_zhuxian', name: '诛仙剑阵', wx: '金', cond: 'crisis', condN: 8, cost: 30,
    desc: '场上怪数 ≥8 时催动：对全场造成 ×4 伤害' },
  { id: 'f_huoyu', name: '焚天火狱', wx: '火', cond: 'kill', condN: 60, cost: 25,
    desc: '累计击杀 ≥60 时催动：对全场造成 ×3.5 伤害' },
  { id: 'f_huguo', name: '玄龟护国', wx: '土', cond: 'hp', condN: 0.35, cost: 20,
    desc: '生命 ≤35% 时催动：立即回复 45% 生命' },
  { id: 'f_binghen', name: '寒冰封界', wx: '水', cond: 'elite', condN: 1, cost: 20,
    desc: '精英出现时催动：对全场造成 ×2 伤害' },
  { id: 'f_muhun', name: '木灵回春', wx: '木', cond: 'period', condN: 25, cost: 15,
    desc: '每 25 次出手催动：回复 18% 生命 + 灵气 +30' },
  { id: 'f_jinwu', name: '金乌焚世', wx: '火', cond: 'crisis', condN: 12, cost: 45,
    desc: '场上怪数 ≥12 时催动：对全场造成 ×6 伤害（底牌）' },
];
const FABAO_BY_ID = {};
FABAO.forEach(f => FABAO_BY_ID[f.id] = f);
// ★ 槽位（用户决策）：1 个法宝 + 2 个道具位
const FABAO_SLOTS = 1;      // 法宝只能装 1 个
const ITEM_SLOTS = 2;       // 剩余 2 个框留给【道具】（设计待定）

// ★ 已拥有的法宝（掉落获得；用户要求：法宝也是掉落）
const FB_OWNED = {};
FABAO.forEach(f => { FB_OWNED[f.id] = false; });
const FB = { eq: [], used: {}, lastSwing: 0 };
function fbEquip(id) {
  if (!FABAO_BY_ID[id]) return false;
  if (FB.eq.includes(id)) { FB.eq = FB.eq.filter(x => x !== id); return true; }
  if (FB.eq.length >= FABAO_SLOTS) FB.eq.shift();
  FB.eq.push(id);
  return true;
}
function fbResetRun() { FB.used = {}; FB.lastSwing = 0; }

// 触发条件判定（每局每件只能催动 1 次）
function fbTriggered(f, ctx) {
  if (FB.used[f.id]) return false;
  switch (f.cond) {
    case 'crisis': return ctx.threats >= f.condN;
    case 'hp':     return ctx.hpPct <= f.condN;
    case 'elite':  return ctx.eliteAlive >= f.condN;
    case 'kill':   return ctx.kills >= f.condN;
    case 'period': return ctx.swings > 0 && ctx.swings % f.condN === 0 && ctx.swings !== FB.lastSwing;
    default:       return false;
  }
}

// ---------------- 三之二·七、传承给赠（提前撤离的兑现）----------------
//
// 用户设计（Round 12 定案）：
//   · 传承是【持续性】的，不是永久的；修为越高持续越久
//   · 余韵 = 提前撤离时的【剩余寿元】× (1 + 大境界序号² × 0.01)
//       ⚠️ 只按【大境界】算（境界内初期/后期只是叫法，除难度外不参与）
//   · 消散分两种：立刻消失 / 大打折扣后再拖一段（效果 ×0.4，时长 ×0.3）
//   · 同类加时间（第 n 层只加 余韵 × 0.5^(n-1)），效果最多 2 层、层数最多 3 层
//   · 接受"自然自限"：高修为交接时剩余寿元天然就少 ⇒ 绝对余韵可能更短
//     （用户后续会加"增加寿元"的事件，那正是高修为路线翻盘的手段）
//
// 四个修为档给不同的东西（"你修为的弟子就算回去了能给后辈什么好传承吗"）：
//   境界 0-1   接续：器物（保命）
//   境界 2-3   封存：灵气 / 护佑
//   境界 4-6   传道：灵气获取 / 突破必成
//   境界 7-11  改命：镇派 / 推演 / 登仙
// ⚠️ 状态说明（Round 12）：
//   ✅ 已生效：slot（器物保全）、keep（器物不损）、ward（护佑）、dao（传道）、灵气封存
//   ⏸️ 待定  ：guard、foresee、sect、ascend —— 它们依赖【尚未实现】的系统，
//             被标了 pending 字段，grantGifts 会跳过它们但在日志里提示。
//             保留而不删，是因为它们记录了原始设计意图，后续做那些系统时会用到。
//   待定项及其依赖的系统：
//     · 护道   → 突破失败机制（渡劫 / 走火入魔）
//     · 推演   → 同上
//     · 镇派   → 分区基础值加成
//     · 登仙   → 羽化飞仙进度系统
const GIFTS = [
  { id: 'slot',    name: '器物保全',   minRealm: 0, layer: '接续', decay: 'slow', desc: '传承槽 +1' },
  { id: 'keep',    name: '器物不损',   minRealm: 0, layer: '接续', decay: 'slow', desc: '身亡时传承不遗落' },
  { id: 'ward',    name: '护佑',       minRealm: 2, layer: '封存', decay: 'used', desc: '下一代首次致命伤免疫' },
  { id: 'dao',     name: '传道',       minRealm: 4, layer: '传道', decay: 'slow', desc: '灵气获取 +15%' },
  { id: 'guard',   name: '护道',       minRealm: 4, layer: '传道', decay: 'slow',
    desc: '突破必定成功', pending: '突破失败机制（渡劫/走火入魔）尚未实现' },
  { id: 'sect',    name: '镇派',       minRealm: 7, layer: '改命', decay: 'slow',
    desc: '一个分区基础值 +20%', pending: '分区基础值加成尚未实现（当前 itemPower 已预留 sm 系数）' },
  { id: 'foresee', name: '推演',       minRealm: 7, layer: '改命', decay: 'slow',
    desc: '突破成功率 +50%', pending: '突破失败机制尚未实现' },
  { id: 'ascend',  name: '登仙',       minRealm: 7, layer: '改命', decay: 'slow',
    desc: '羽化飞仙进度 +1', pending: '羽化飞仙进度系统尚未实现' },
];
// 特殊：灵气封存（境界≥2，一次性）
const INHERIT_QI_MIN_REALM = 2;

// 当前生效的给赠：{ quiet, phase, layers, powerLayers }
//   quiet = 余韵剩余秒；phase = 1（满）/ 2（折扣）/ 3（已散）
let GIFTS_ACTIVE = {};
let QI_LOCK_TOTAL = 0;        // 累计"灵气封存"兑现量（展示用）

function giftPower(id) {
  const g = GIFTS_ACTIVE[id];
  if (!g || g.phase >= 3) return 0;
  const stack = 1 + (Math.min(g.powerLayers, P.LEGACY_MAX_EFFECT_STACK) - 1) * 1.0;
  return stack * (g.phase === 2 ? P.LEGACY_PHASE2_EFFECT : 1);
}
function giftOn(id) { return giftPower(id) > 0; }

// 施加给赠（交接时调用）：按大境界选档、算余韵、处理叠加
function grantGifts(remainSec) {
  const r = realm();
  const quietMul = 1 + r * r * P.LEGACY_QUIET_REALM2;
  const base = remainSec * quietMul;
  const got = [], pending = [];
  for (const g of GIFTS) {
    if (r < g.minRealm) continue;
    if (g.pending) { pending.push(g.name); continue; }   // 依赖未实现 ⇒ 暂不生效
    const cur = GIFTS_ACTIVE[g.id];
    if (cur && cur.phase < 3) {
      if (cur.layers >= P.LEGACY_MAX_STACK) continue;  // 层数软上限
      const add = base * Math.pow(0.5, cur.layers);
      cur.quiet += add; cur.layers++; cur.powerLayers++; cur.phase = 1;
      got.push(g.name + '+延' + Math.round(add / 60) + '分');
    } else {
      GIFTS_ACTIVE[g.id] = { quiet: base, phase: 1, layers: 1, powerLayers: 1 };
      got.push(g.name + '(' + Math.round(base / 60) + '分)');
    }
  }
  // 灵气封存（一次性，立即到账）
  if (r >= INHERIT_QI_MIN_REALM) {
    const atk = P.ATK_BASE * Math.pow(P.R_ATK, G.tier);
    const qi = Math.floor(remainSec * atk * P.KILL_RATE_PER_ATK * P.OFFLINE_EFFICIENCY);
    if (qi > 0) { PENDING_QI += qi; QI_LOCK_TOTAL += qi; got.push('灵气封存+' + qi); }
  }
  return { got, pending, base, quietMul };
}

// 推进余韵（每 tick 用现实秒推进 ⇒ 挂机也在流逝）
function tickGifts(dtSec) {
  for (const id of Object.keys(GIFTS_ACTIVE)) {
    const g = GIFTS_ACTIVE[id];
    if (g.phase >= 3 || g.quiet === Infinity) continue;
    const before = g.quiet;
    g.quiet -= dtSec;
    if (g.quiet > 0) continue;
    if (g.phase === 1) {
      // 进入阶段二：效果 ×0.4、时长 ×0.3（"大打折扣后再拖一段"）
      g.phase = 2;
      g.quiet = before * P.LEGACY_PHASE2_TIME;
    } else {
      g.phase = 3;
      ev('gift_fade', 4, { id });
    }
  }
}

// 传承栏状态
function giftStatus() {
  const out = [];
  for (const g of GIFTS) {
    const a = GIFTS_ACTIVE[g.id];
    if (!a || a.phase >= 3) continue;
    out.push({ id: g.id, name: g.name, desc: g.desc, phase: a.phase,
      power: giftPower(g.id), layers: a.powerLayers,
      left: a.quiet === Infinity ? -1 : a.quiet });
  }
  return out;
}

// ---------------- 三之二·六、主动撤离 / 提前交接传承 ----------------
// 用户提案："主动撤，就相当于提前交接传承"
//
// 它补上了【风险 vs 交接】的取舍：
//   不撤     → 继续刷（可能暴富，也可能身亡丢传承）
//   寿元耗尽 → 善终，传承完整带回，但【剩余价值为零】
//   主动撤离 → 立刻交接；传承完整带回，且【剩余寿元兑现给下一代】
//
// ★ "兑现"的方向 = 时间压缩（与既有原则一致：传承不给更高上限，只让你更快）
//   剩余寿元 × 换算率 ⇒ 下一代的【灵气启动金】⇒ 起步就跳过几档
//
// 换算率按弟子当前修为：境界基准攻击 × KILL_RATE_PER_ATK
//   （修为越高，每秒寿元能兑现的灵气越多）
let PENDING_QI = 0;          // 提前交接时留给下一代的灵气

function legacyQiValue() {
  if (DISCIPLE.lifespanLeft <= 0) return 0;
  const baseAtk = P.ATK_BASE * Math.pow(P.R_ATK, G.tier);
  const rate = baseAtk * P.KILL_RATE_PER_ATK;          // 只/秒
  return Math.floor(DISCIPLE.lifespanLeft * rate * P.OFFLINE_EFFICIENCY);
}

// 主动撤离（战斗中或间隔期都可以点）
function extractNow() {
  if (G.running) {
    // 战斗中撤离：本局收获照拿（这就是"搜打撤"的"撤"）
    const rate = G.t > 0 ? G.kills / G.t : 0;
    const bonus = Math.floor(rate * 30);   // 多结算 30 秒的击杀（象征"收拾战利品"）
    if (bonus > 0) gainQi(bonus);
    ev('extract', 5, { kills: G.kills, t: Math.round(G.t), bonus });
    log('▸ 主动撤离 · 本局击杀 ' + G.kills + ' · 额外结算灵气 +' + bonus, 'ok');
    G.running = false; G.phase = 'idle';
    setTimeout(() => { doExtractHandover(); }, 400);
    return true;
  }
  doExtractHandover();
  return true;
}

function doExtractHandover() {
  const remain = DISCIPLE.lifespanLeft;
  // ★ 交接给赠：按大境界选档 + 按剩余寿元算余韵
  const res = grantGifts(remain);
  if (res.pending.length) log('　（待定：' + res.pending.join('、') + ' —— 依赖尚未实现的系统）', 'sys');
  if (remain > 0) {
    ev('handover', 8, { qi: QI_LOCK_TOTAL, hours: remain / 3600, realm: realm() });
    log('✦ 提前交接 · 剩 ' + (remain / 3600).toFixed(2) + ' 小时 × 余韵 ×' +
      res.quietMul.toFixed(2) + ' ⇒ ' + (res.base / 3600).toFixed(2) + ' 小时', 'break');
    if (res.got.length) log('　传承给赠：' + res.got.join('、'), 'ok');
  } else {
    log('✦ 弟子寿元已尽 · 无法留下余韵（只能在寿元未尽时主动交接）', 'bad');
  }
  endDisciple('handover');
}

// ---------------- 三之二·十一、词缀（27 条 · 乘区分配见层2 §38）----------------
//
// 设计依据（层2 §37 §38）：
//   · 乘区分配：状态 10 条（×1.115）· 时序 4 条（×1.078）
//               属性相性 3 条 · 防御减免 3 条 · 纯负面 4 条 · A08/A10 2 条
//   · 条数按稀有度：精良 1 · 史诗 3 · 传奇 3+1专属 · 神话 4+1签名
//   · 数值缩放：实际值 = 基准值 × 品级系数 × (1 + ilvl × 0.006)
//               品级系数 精良 0.55 · 史诗 0.75 · 传奇 0.90 · 神话 1.00
//
// zone：st=状态 · ti=时序 · wx=属性相性 · df=防御减免 · neg=纯负面
const AFFIXES = [
  // ---- 状态 10 条（合计基准 +11.5%）----
  { id:'A02', name:'疾风', zone:'st', base:1.4, tier:2, desc:'出手频率 +X%', cost:'单次伤害 −X/2%' },
  { id:'A23', name:'献祭', zone:'st', base:1.9, tier:3, desc:'攻击 +X%', cost:'战斗开始失去 30% 生命' },
  { id:'A03', name:'暴烈', zone:'st', base:1.6, tier:3, desc:'暴击率与暴伤 +X%', cost:'非暴击伤害 −20%' },
  { id:'A21', name:'免死', zone:'st', base:1.4, tier:2, desc:'免死一次并回血 20%', cost:'触发后全属性 −20%' },
  { id:'A17', name:'回春', zone:'st', base:1.2, tier:2, desc:'每 5 刻度回复 X% 生命', cost:'攻击力 −15%' },
  { id:'A01', name:'破军', zone:'st', base:1.1, tier:2, desc:'攻击 +X%', cost:'速度 −X/2%' },
  { id:'A19', name:'引灵', zone:'st', base:0.9, tier:2, desc:'每秒本源 +X%', cost:'生命上限 −X%' },
  { id:'A22', name:'连锁', zone:'st', base:0.8, tier:1, desc:'暴击追加 50% 伤害', cost:'暴击率 −15%' },
  { id:'A18', name:'蚀骨', zone:'st', base:0.7, tier:1, desc:'命中削防 X%（叠 3 层）', cost:'每层自身防御 −5%' },
  { id:'A04', name:'恒常', zone:'st', base:0.5, tier:1, desc:'伤害浮动收窄、命中 +X%', cost:'暴击率 −10%' },
  { id:'A20', name:'御灵', zone:'st', base:0.4, tier:1, desc:'开场获得 8 本源', cost:'之后本源获取 −20%' },
  // ---- 时序 4 条（合计基准 +7.8%）----
  { id:'A12', name:'蓄势', zone:'ti', base:2.4, tier:3, desc:'每 10 刻度攻击 +X%（叠 5 层）', cost:'前 10 刻度攻击 −20%' },
  { id:'A11', name:'先手', zone:'ti', base:2.2, tier:3, desc:'前 15 刻度全属性 +X%', cost:'15 刻度后 −X%' },
  { id:'A14', name:'后发', zone:'ti', base:1.8, tier:2, desc:'血量 <50% 时攻速 +X%', cost:'满血时攻速 −10%' },
  { id:'A13', name:'残战', zone:'ti', base:1.4, tier:2, desc:'目标血量 <30% 时 +X%', cost:'目标满血时 −15%' },
  // ---- 属性相性 3 条（不计入伤害预算）----
  { id:'A06', name:'焚身', zone:'wx', base:8.0, tier:2, desc:'火系伤害 +X%', cost:'承受水系伤害 +12%' },
  { id:'A07', name:'凝霜', zone:'wx', base:8.0, tier:2, desc:'水系伤害 +X%', cost:'承受火系伤害 +12%' },
  { id:'A09', name:'五行·御', zone:'wx', base:8.0, tier:2, desc:'抵抗被克伤害 +X%', cost:'对克制伤害 −5%' },
  // ---- A08 / A10（保留，数值保守 · 用户决策）----
  { id:'A08', name:'五行·攻', zone:'wx', base:6.0, tier:3, desc:'对克制目标 +X%', cost:'对被克制目标 −X%' },
  { id:'A10', name:'破相', zone:'wx', base:50, tier:3, desc:'无视目标相性加成的 X%', cost:'自身相性加成失效' },
  // ---- 防御减免 3 条（受击侧）----
  { id:'A05', name:'穿透', zone:'df', base:6.0, tier:2, desc:'无视目标 X% 防御', cost:'对无防御目标无收益' },
  { id:'A15', name:'铁壁', zone:'df', base:8.0, tier:2, desc:'防御 +X%', cost:'出手间隔 +10%' },
  { id:'A16', name:'血煞', zone:'df', base:8.0, tier:2, desc:'最大生命 +X%、反伤 +5%', cost:'治疗效果 −50%' },
  // ---- 纯负面 4 条 ----
  { id:'A24', name:'滞涩', zone:'neg', base:15, tier:1, desc:'（无正收益）', cost:'出手频率 −X%' },
  { id:'A25', name:'虚弱', zone:'neg', base:10, tier:1, desc:'（无正收益）', cost:'全属性 −X%' },
  { id:'A26', name:'破绽', zone:'neg', base:30, tier:1, desc:'（无正收益）', cost:'承受暴击伤害 +X%' },
  { id:'A27', name:'枯竭', zone:'neg', base:25, tier:1, desc:'（无正收益）', cost:'本源获取 −X%' },
];
const AFFIX_BY_ID = {};
AFFIXES.forEach(a => AFFIX_BY_ID[a.id] = a);

// 词缀条数（按稀有度）与品级系数
const AFFIX_COUNT = [0, 1, 3, 3, 4];             // 普通/精良/史诗/传奇/神话
const AFFIX_QLV = [0, 0.55, 0.75, 0.90, 1.00];   // 品级系数
const AFFIX_ILVL_RATE = 0.006;

// 一条词缀在该件装备上的实际数值
function affixValue(af, q, ilvl) {
  return Math.round(af.base * AFFIX_QLV[q] * (1 + ilvl * AFFIX_ILVL_RATE) * 10) / 10;
}
// 给一件装备抽词缀（按品质决定条数）
function rollAffixes(q, ilvl) {
  const n = AFFIX_COUNT[q] || 0;
  if (n === 0) return [];
  const pool = AFFIXES.filter(a => a.zone !== 'neg').map(a => a.id);
  const picked = [];
  for (let i = 0; i < n && pool.length; i++) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}
// 单件装备在各乘区贡献的【百分比之和】
//   ⚠️ 必须用【加算】—— 层1 §4.1 定的是"同乘区内相加，乘区之间相乘"。
//   曾误用乘法聚合（out[z] *= ...），导致 4 条时序词缀变成连乘而非相加。
//
// facing: 'player'=玩家打出（克制时加成）· 'incoming'=玩家承受（被克时加成）
//   A08 五行·攻 → player 面 · A09 五行·御 → incoming 面（两种角色）
//   the rest 两边都算
// 身上是否挂着某条词缀（整个 11 槽里任意一件）
// 某条词缀在当前 11 槽装备上的实际百分比（取该词缀的最大值）
function affixNegPct(id) {
  let v = 0;
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (!c || !c._anchor || !c.affixes || c.affixes.indexOf(id) < 0) continue;
      const af = AFFIX_BY_ID[id];
      if (af) v = Math.max(v, affixValue(af, c.q, c.ilvl));
    }
  }
  return v;
}
function affixHas(id) {
  return negHas(id);
}
function negHas(id) {
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (c && c._anchor && c.affixes && c.affixes.indexOf(id) >= 0) return true;
    }
  }
  return false;
}
// A08 让【玩家打出】的相性上限从 ×1.30 提到 ×1.378（用户决策 A）
const AFFIX_WX_BONUS = 0.378;

function affixPctOf(c, facing) {
  const out = { st: 0, ti: 0, wx: 0, df: 0, neg: 0 };
  if (!c || !c.affixes) return out;
  for (const id of c.affixes) {
    const af = AFFIX_BY_ID[id];
    if (!af) continue;
    const v = affixValue(af, c.q, c.ilvl);
    if (af.zone === 'st' || af.zone === 'ti') { out[af.zone] += v / 100; continue; }
    if (af.zone === 'neg') { out.neg += v / 100; continue; }
    if (id === 'A08') { if (facing === 'player') out.wx += v / 100; continue; }
    if (id === 'A09') { if (facing === 'incoming') out.wx += v / 100; continue; }
    out[af.zone] = Math.max(out[af.zone], v / 100);
  }
  return out;
}
function affixPct(it) {
  const p = affixPctOf(it, 'player');
  const q = affixPctOf(it, 'incoming');
  return { st: p.st, ti: p.ti, wx: Math.max(p.wx, q.wx), df: Math.max(p.df, q.df), neg: p.neg,
    wxP: p.wx, wxI: q.wx };
}
// 单件装备的乘区"合计倍率"（供外部调用）
function affixMul(it) {
  const p = affixPct(it);
  return { st: 1 + p.st, ti: 1 + p.ti, wx: 1 + p.wx, df: 1 + p.df };
}
// 整套装备的词缀乘区：同区【全部相加】后套【软上限】（层2 §35.5 + 用户修正）
const AFFIX_ZONE_CAP = { st: 1.20, ti: 1.15 };
// ★ 预算的【软上限】（用户要求）
//   硬夹取：超过上界 ⇒ 完全无收益（堆多了白费）
//   软上限：超过上界 ⇒ 超出部分按 SOFT_BUDGET_RATE 折算（与防御的写法同构）
const SOFT_BUDGET_RATE = 0.40;
function softCapMul(raw, cap) {
  if (raw <= cap) return raw;
  return cap + (raw - cap) * SOFT_BUDGET_RATE;
}
// ★ 词缀乘区汇总（一趟遍历算完，不要重复扫）
//   · 状态 / 时序：【跨件相加】后套软上限（上界就是为"能堆多少"设计的）
//   · 属性相性 / 防御减免：【取最大值】（同一条词缀不会因两件装备而叠加）
//   · 区分【玩家面 wxP】与【受击面 wxI】（A08 / A09 是同一角色的两面）
function affixZones() {
  let stSum = 0, tiSum = 0;
  let wxP = 0, wxI = 0, df = 0, neg = 0;
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (!c || !c._anchor) continue;
      const p = affixPctOf(c, 'player');
      const q = affixPctOf(c, 'incoming');
      stSum += p.st; tiSum += p.ti;
      wxP = Math.max(wxP, p.wx);
      wxI = Math.max(wxI, q.wx);
      df = Math.max(df, p.df);
      neg = Math.max(neg, p.neg);
    }
  }
  const rawSt = 1 + stSum, rawTi = 1 + tiSum;
  const soft = (rawSt > AFFIX_ZONE_CAP.st + 1e-9) || (rawTi > AFFIX_ZONE_CAP.ti + 1e-9);
  return {
    st: softCapMul(rawSt, AFFIX_ZONE_CAP.st),
    ti: softCapMul(rawTi, AFFIX_ZONE_CAP.ti),
    rawSt, rawTi, soft, capped: soft,
    wxP, wxI, df, neg,
  };
}
// ---------------- 三、游戏状态 ----------------
const G = {
  shield: 0, shieldT: 0,   // ★ 护盾（金钟罩 / 凝神归元）
  // ★ Round 10：境界与难度合并为【修为】单轴
  //
  //   原设计是双轴（境界 5 档 + 难度 10 档），但两者本质是同一个"深度轴"。
  //   合并后突破有真实意义，且删掉了"手动调难度"这个反直觉操作。
  //
  //   tier  = 修为档（0~9），同时决定【大境界】与【小怪难度】
  //   realm = 大境界（0~4）= floor(tier / 2)
  tier: 0,
  qi: 0,                 // 当前灵气（满了自动突破）
  qiTotal: 0,            // 累计灵气（统计用）
  breakCount: 0,         // 已突破次数
  hp: 0, hpMax: 0,
  origin: 0,
  materials: 0,          // ⚠️ 已废弃（Round 18：素材搬到 SECT_RES.materials）
  // 战斗
  running: false, phase: 'idle',   // idle / fight / rest
  t: 0, spawned: 0, budget: 780, kills: 0, elites: 0,
  field: [], actAcc: 0, spawnAcc: 0, overloadT: 0,
  deathT: null, peakField: 0, downgraded: 0,
  fx: [], shake: 0, hurtAcc: 0, threats: 0,
  // ★ R61：表现层队列（数值瞬时结算，这两个只管"让玩家看见过程"）
  vfxq: [],           // 战斗特效事件：arc 近战弧光 / proj 弹道
  dmgq: [],           // 延后出现的伤害飘字（远程要等弹道飞到）
  heroX: 0.5, heroY: 0.56, wanderT: 0, wanderTarget: null,
  dodgeAcc: 0, dodgeFlash: 0, dashT: 0, crowdAvoid: 0,
  mobAtkAcc: 0, mobAtkT: 0,   // ★ R210：怪出手的累积器（伤害 + 节拍）
  lastPressure: null, // 上一局的【承压强度】（威胁圈内怪数 ÷ 阈值），驱动避怪权重
  lastKillRate: 0,    // （保留）上一局击杀速率，仅用于展示
  lastSurvived: true,
  _seenAt: Date.now(),   // 上次查看报告的时间
  // ★ 身法钩子（预留）：闪避成功计数与最近一次闪避时间
  dodgeCount: 0, lastDodgeT: -99,
  // 装备：分区 → 占位网格
  zones: {},        // zone -> { w, h, cells: [[itemId|null]] }
  bag: [],          // 未装备的掉落
  // ★ 掉落过滤（装备与掉落.md §7.2 第 1 层）
  filterQ: 0,        // 品质 < 此值的掉落自动分解（默认 0 = 全留）
  onlyUpgrade: false,// 只显示"有提升"的
  sortsBy: 'score',  // 排序：score / q / slot
  compare: null,     // 正在对比的物品
  // 统计
  log: [], totalKills: 0, runs: 0,
  dropped: 0, disenchanted: 0,
};

// ★ 大境界由修为档派生（每 2 档一个大境界）
const REALM_PER_TIER = 2;
// 档位 → 大境界
//   炼气期 = 第 1 档（单独）
//   其余每 2 档一个大境界：第 2~3 档 = 筑基，第 4~5 档 = 金丹 …
//   ⇒ realmOf(t) = ceil(t / 2)，夹在境界数内
function realmOf(tier) {
  return Math.min(P.REALMS.length - 1, Math.ceil(tier / REALM_PER_TIER));
}
function realm() { return realmOf(G.tier); }
// 突破所需的灵气（每档递增）
function qiNeed(tier) {
  return Math.round(P.QI_BASE * Math.pow(tier + 1, P.QI_EXP) / 10) * 10 * traitMul('qi');   // ★ 天赋条目：通玄
  // 超线性曲线：qiNeed(t) = QI_BASE × (t+1)^QI_EXP
  return Math.round(P.QI_BASE * Math.pow(tier + 1, P.QI_EXP) / 10) * 10;
}
function zoneCap(zone) { return ZONE_CAP[zone][realm()]; }
function zoneRect(zone) {
  const cap = zoneCap(zone);
  // ★ 修正：所有分区都应【随容量扩】，原来只有躯干/双手会扩，
  //   头/背/手臂/双腿 被硬编码成固定小矩形 ⇒ ZONE_CAP 对它们形同虚设。
  //   后果：高档时【头只能放 1 件、双腿只能放 1 件】
  //   ⇒ 11 个部位装不下 ⇒ 【同调等级 5 永远不可达】（用户要求修复）
  const [w] = ZONE_RECT[zone];
  const width = Math.max(2, w);
  const h = Math.max(1, Math.ceil(cap / width));
  return [width, h];
}

function initZones() {
  G.zones = {};
  for (const z of Object.keys(ZONE_CAP)) {
    const [w, h] = zoneRect(z);
    const cells = [];
    for (let y = 0; y < h; y++) cells.push(new Array(w).fill(null));
    G.zones[z] = { w, h, cells };
  }
}
initZones();

// ---------------- 四、装备生成 ----------------
let UID = 1;
function makeItem(ilvl, forcedQ) {
  const slots = Object.keys(SLOT_ZONE);
  const slot = slots[Math.floor(Math.random() * slots.length)];
  // 品质权重（★ Round 24 重写：神话随境界缓慢上升，低境界几乎不掉）
  //
  //   ⚠️ 用户反馈："感觉神话装备掉的有点多了，感觉罕度和境界要分开，
  //      神话这种不该掉这么多，修为境界越低越不可能获取才对，
  //      随着境界上升逐渐增加概率，但是整体概率还是应该很低"
  //
  //   ⚠️ 旧公式的三个问题：
  //     ① 神话固定 1%（roll < 0.99 之后就进 else），【完全不随境界变化】
  //     ② 一局约 100 件掉落 × 1% ≈ 9 件神话/局 ⇒ 满地神话
  //     ③ bias 只把低品质"平移"成中品质，神话那 1% 纹丝不动
  //
  //   ⇒ 新公式：各品质概率【按境界线性插值】，神话 0.01% → 1.0%
  let q = 0;
  if (forcedQ != null) q = forcedQ;
  else {
    // ★ Round 25（用户要求）：神话在【炼虚期】达到 1%，前面低、后面高
    //   "我觉得神话掉落率在炼虚就差不多改到1%了吧，前面低一点，后面高一点"
    //   炼虚 = 档 11 ⇒ f = (1+10×6)/240 = 61/240 ≈ 0.254
    //   ⇒ 分段线性：f < 0.254 快速升到 1%；之后缓升到 1.8%（顶）
    const f = Math.min(1, ilvl / 240);
    const KNEE = 61 / 240;                        // ≈0.2542（炼虚期）
    // 两段线性：前段 a0 → aK（到炼虚），后段 aK → aEnd
    const twoSeg = (a0, aK, aEnd) => f <= KNEE
      ? a0 + (aK - a0) * (f / KNEE)
      : aK + (aEnd - aK) * ((f - KNEE) / (1 - KNEE));
    const pM = twoSeg(0.0015, 0.010, 0.018);      // 神话 0.15% → 【炼虚 1.0%】 → 天仙 1.8%
    const pL = twoSeg(0.010, 0.030, 0.055);       // 传奇 1.0%  → 炼虚 3.0%  → 5.5%
    const pE = twoSeg(0.10, 0.20, 0.30);          // 史诗 10%   → 炼虚 20%   → 30%
    const pG = 0.26;                              // 精良 固定 26%
    const roll = Math.random();
    if (roll < pM) q = 4;
    else if (roll < pM + pL) q = 3;
    else if (roll < pM + pL + pE) q = 2;
    else if (roll < pM + pL + pE + pG) q = 1;
    else q = 0;
  }
  const shape = SHAPES[slot][q];
  // ★ 修正：品质差异必须真的体现在数值上。
  //   原来 ilvl=60 时计算得 73.07，四舍五入到整数后【普通/精良/史诗可能同值】，
  //   导致"品质"形同虚设。现在保留 1 位小数，低 ilvl 也能区分品质。
  const baseVal = P.ITEM_VAL_BASE * Math.pow(P.ITEM_VAL_RATE, ilvl) * P.QUALITY_STAT_MUL[q];
  const kind = SLOT_MAIN[slot];
  const raw = baseVal * (kind === '生命' ? 3 : 1);
  const main = Math.round(raw * 10) / 10;
  // ★ 武器：随机抽一个类型，决定 攻击范围 / AOE / 伤害系数
  let weapon = null;
  if (slot === '主手' || slot === '副手') {
    weapon = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
  }
  return {
    id: UID++, slot, q, ilvl, shape, cells: shape[0] * shape[1],
    kind, main, mainVal: main, home: SLOT_ZONE[slot],
    weapon: weapon ? weapon.id : null,
    affixes: rollAffixes(q, ilvl),   // ★ 词缀（按稀有度决定条数）
    sig: (q === 4) ? rollSignature() : null,   // ★ 神话签名（1 件恰好 1 条）
    name: (q === 4) ? rollMythName(slot, weapon ? weapon.id : null) : null,  // ★ 神话威名
    _new: true,        // 新掉落标记（用于高亮）
  };
}

// ★ 词缀的显示（卡片一行 + 悬停详情）
function affixLabel(it) {
  if (!it || !it.affixes || !it.affixes.length) return "";
  return it.affixes.map(id => {
    const a = AFFIX_BY_ID[id];
    return a ? ("[" + a.name + "]") : "";
  }).join("");
}
function affixTitle(it) {
  if (!it || !it.affixes || !it.affixes.length) return "无词缀（普通装备）";
  return it.affixes.map(id => {
    const a = AFFIX_BY_ID[id];
    if (!a) return "";
    const v = affixValue(a, it.q, it.ilvl);
    const zone = { st:"状态", ti:"时序", wx:"属性相性", df:"防御减免", neg:"纯负面" }[a.zone] || a.zone;
    return "【" + a.name + "】" + zone + "\n  " +
      a.desc.replace("X", v) + "\n  代价：" + a.cost.replace("X", v);
  }).join("\n");
}

// ★ 神话签名的显示（卡片一行 + 悬停详情）
function sigLabel(it) {
  if (!it || !it.sig) return "";
  const s = SIGNATURE_BY_ID[it.sig];
  return s ? ("★" + s.name) : "";
}
function sigTitle(it) {
  if (!it || !it.sig) return "";
  const s = SIGNATURE_BY_ID[it.sig];
  if (!s) return "";
  return "【神话签名·" + s.name + "】五行 " + s.wx + "\n  " + s.desc +
    "\n  — 同源时同调 +" + SIGN_SAME_BONUS + "（满同调 = 11 同源 + 1 同源签名）" +
    "\n  — 不可重铸、不可转移（属这件物品的身份）";
}

// ★ 该部位当前穿的那件（用于"比我现在的好吗"）
function equippedInSlot(slot) {
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (c && c._anchor && c.slot === slot) return c;
    }
  }
  return null;
}
// ★ "值得一看"的判据（只标差异，不给结论）：
//   和【同部位当前穿着的那件】比主属性；没有同部位装备时，看它能否被装进构建
function upgradeDelta(it) {
  // ★ Round 24 修复：原实现是 `it.mainVal / cur.mainVal - 1`
  //
  //   ⚠️ 为什么错：不同部位的属性【量纲不同】（主手是攻击、肩是防御、
  //      胸是生命×3），直接相除毫无意义。
  //      实测后果：用户截到「神话 肩 ▲566%」这种荒谬数字。
  //
  //   ⇒ 改用【综合战力提升】（与 evaluateSwap 同口径）：
  //      把当前穿戴和新装备各装一次，比较 combatValue
  const cur = equippedInSlot(it.slot);
  const ev = evaluateSwap(it);
  let gain = ev.gain;
  // 空槽位时从 0 起算，避免 "空 → 第一件" 出现天文数字
  if (!cur && !isFinite(gain)) gain = 1;
  if (!isFinite(gain)) gain = 0;
  // 收敛到 ±(0,1) 区间，避免单件装备显示成几百 %
  gain = Math.max(-0.95, Math.min(5.0, gain));
  return { kind: cur ? 'slot' : 'new', ratio: gain };
}
// 分解产出
function disenchantValue(it) { return DROP.DISENCHANT[it.q]; }

// ★ 指定部位的装备工厂（测试与"保底掉落"用）
//   修复：直接改 it.slot 会留下原部位的 kind，
//   导致出现"胸甲吃生命 +×3"这类【非法物品】（我的测试助手就踩了这个坑）
function makeSlotItem(slot, ilvl, q, weaponId) {
  const it = makeItem(ilvl, q);
  it.slot = slot;
  it.home = SLOT_ZONE[slot];
  it.shape = SHAPES[slot][q];
  it.cells = it.shape[0] * it.shape[1];
  it.kind = SLOT_MAIN[slot];
  const raw = P.ITEM_VAL_BASE * Math.pow(P.ITEM_VAL_RATE, ilvl) * P.QUALITY_STAT_MUL[q] * (it.kind === '生命' ? 3 : 1);
  it.mainVal = Math.round(raw * 10) / 10;
  it.main = it.mainVal;
  // ★ 武器类型：改了 slot 之后必须重新判定
  //   （原来漏了这步 ⇒ 强制成"主手"后 weapon 是 null ⇒ playerStats 认成空手 ⇒ 打不动怪）
  if (slot === '主手' || slot === '副手') {
    it.weapon = weaponId || WEAPONS[Math.floor(Math.random() * WEAPONS.length)].id;
  } else {
    it.weapon = null;
  }
  // ★ 装备自身的五行（掉落时随机）——主手由武器决定，不重复给
  it.affixes = it.affixes || rollAffixes(q, ilvl);   // ★ 词缀
  if (!it.sig) it.sig = (q === 4) ? rollSignature() : null;   // ★ 神话签名
  it.name = (q === 4) ? rollMythName(slot, it.weapon) : null;   // ★ 神话威名（按修正后的部位/武器重抽）
  // ★ 武器类型与属性解耦（Round 16 · 用户要求："每种武器都有 5 种属性用来匹配同调"）
  //   武器类型（WEAPON_BY_ID[].wuxing 字段名保留但只作历史兜底）不再决定 wx；
  //   主手/副手与其它 9 槽一样，都 rollWuxing() ⇒ 武器也能吃同源/相生。
  if (!it.wx) it.wx = rollWuxing();
  return it;
}
// ★ 装备显示名：神话优先用专属威名，其余用"部位·武器类型"
function itemName(it) {
  if (!it) return '装备';
  if (it.name) return it.name;
  return (it.slot || '装备') + (it.weapon ? '·' + WEAPON_BY_ID[it.weapon].name : '');
}
// ★ 带品质前缀（"神话·踏云靴" / "传奇·靴"）
function itemNameQ(it) {
  if (!it) return '';
  return (QUALITIES[it.q] || '') +
    (it.name ? '·' + it.name : (it.slot || '') + (it.weapon ? '·' + WEAPON_BY_ID[it.weapon].name : ''));
}
// ★ 校验一件装备是否"合法"（部位/形状/主属性一致）
function isLegalItem(it) {
  const shape = SHAPES[it.slot] && SHAPES[it.slot][it.q];
  if (!shape) return false;
  if (it.shape[0] !== shape[0] || it.shape[1] !== shape[1]) return false;
  if (it.kind !== SLOT_MAIN[it.slot]) return false;
  if (it.home !== SLOT_ZONE[it.slot]) return false;
  if (it.cells !== shape[0] * shape[1]) return false;
  return true;
}

// ★ 装备的"本征值"（它有多好）与"承载上限"（你现在能用多少）
//
// 用户提案："修为弱小的时候，也承受不了强的装备"
//   effIlvl = min( 该档自然掉落品级 , 装备本征品级 )
// ⇒ 传承的传奇装备【随修为逐步解封】，到该档时恰好等于"该档的自然传奇"
//   ⇒ 永远不破坏该档配平，只是让弟子"开局就有那个档次的好东西"
//   ⇒ 副作用（正面）：装备成长也被境界锁住 ⇒ "境界是唯一乘性来源"更严格成立
//
// ⚠️ 两个必须与掉落系统保持一致的量（子代理核对时发现、我原先写错了）：
//   ① 每档品级步长 = DROP.ILVL_PER_TIER（=6，**不能**用硬编码 3）
//   ② 满级品级 = 1 + (TIERS-1) × 步长（= 1+23×6 = 139）
//   我曾写成 `1 + tier*3` 且上限 70 ⇒ **高档的传承装反而比新掉落的弱**
//
//   规则明确为：
//     · 神话/传奇（q≥3）⇒ 本征品级 = 满级品级。它们是"跨代遗产"：
//       在该档等于该档传奇，之后每个档都仍是最新的传奇（"永远不落伍"）
//     · 精良及以下（q≤2）⇒ 本征品级 = 掉落时 ilvl。它们会【自然过时】
//   ⇒ 只有值得珍惜的东西才配成为遗产，也解释了"为什么要刷传奇"
const LEGACY_MAX_ILVL = 1 + (P.TIERS - 1) * DROP.ILVL_PER_TIER;
function effIlvlFor(it) {
  const natural = 1 + G.tier * DROP.ILVL_PER_TIER;    // 该档自然掉落品级
  const intrinsic = (it.q >= 3) ? LEGACY_MAX_ILVL : it.ilvl;   // 传奇以上视为遗产
  return Math.min(natural, intrinsic);
}
function itemRawValue(it) {
  const eff = it.ilvl > 0 ? effIlvlFor(it) : 1;
  const mult = (SLOT_MAIN[it.slot] === '生命') ? 3 : 1;
  return P.ITEM_VAL_BASE * Math.pow(P.ITEM_VAL_RATE, eff) * P.QUALITY_STAT_MUL[it.q] * mult;
}
// 该装备当前实际有效的品级（用于 UI 显示"封印中/已解封"）
function isCapped(it) { return it.ilvl > effIlvlFor(it) + 0.01; }

function itemPower(it, zone) {
  // 返回该装备放在该区的实际贡献（简化版六乘区）
  const e = offzone(it.slot, zone);
  const keep = e.keep;
  const conv = e.convert, cmul = e.cmul;
  let out = { 攻击: 0, 防御: 0, 生命: 0, 速度: 0, 命中: 0, 承压: 0, 清场: 0 };
  const amt = itemRawValue(it) * keep;
  if (e.same) {
    out[it.kind] = amt;
  } else {
    const t = conv === '攻击力' ? '攻击' : conv === '防御' ? '防御'
      : conv === '出手频率' ? '速度' : conv === '命中与暴击' ? '命中'
      : conv === '承压阈值' ? '承压' : '清场';
    out[t] = amt * cmul;
  }
  return out;
}

function playerStats() {
  // ★ 属性随【修为档】成长（不是随大境界）
  //
  //   原来按大境界算 ⇒ 同一境界内两档玩家属性完全不变，
  //   但小怪每档 +25% ⇒ "末期更难"变成纯惩罚，玩家侧没有补偿。
  //   改为按档成长后：每档玩家 ×1.0946 · 小怪 ×1.25 ⇒ 每档难度 +14%（合理递增）
  const baseAtk = P.ATK_BASE * Math.pow(P.R_ATK, G.tier);
  const baseHp = P.HP_BASE * Math.pow(P.R_HP, G.tier);
  const baseDef = P.DEF_ANCHOR * Math.pow(P.R_DEF, G.tier);
  let bonus = { 攻击: 0, 防御: 0, 生命: 0, 速度: 0, 命中: 0, 承压: 0, 清场: 0 };
  let zoneMod = { atk: 0, def: 0, freq: 0, hit: 0, thresh: 0, clear: 0 };
  const zoneHas = {};
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    let used = 0;
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const it = zc.cells[y][x];
      if (!it || typeof it !== 'object') continue;
      if (it._anchor) {   // 只统计锚点格，避免重复
        used += it.cells;
        const p = itemPower(it, z);
        for (const k of Object.keys(bonus)) bonus[k] += p[k] || 0;
        if (z === it.home) zoneHas[z] = true;
      }
    }
    if (used > 0 && zoneHas[z]) {
      const m = ZONE_MOD[z];
      if (m.stat === '攻击力') zoneMod.atk += m.add;
      if (m.stat === '防御') zoneMod.def += m.add;
      if (m.stat === '出手频率') zoneMod.freq += m.add;
      if (m.stat === '命中与暴击') zoneMod.hit += m.add;
      if (m.stat === '承压阈值') zoneMod.thresh += m.add;
      if (m.stat === '清场速度') zoneMod.clear += m.add;
    }
  }
  // ★ 武器决定：攻击范围 / AOE / 伤害系数
  //   取【主手】的武器为主；主手空着则用副手；都没有则用"空手"（很短、只打1个）
  let mainWeapon = null, offWeapon = null;
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const it = zc.cells[y][x];
      if (!it || !it._anchor || !it.weapon) continue;
      // 只有放在本位区（双手）的武器才算"握在手里"
      const inHand = (z === '双手');
      if (it.slot === '主手') mainWeapon = inHand ? it : null;
      if (it.slot === '副手') offWeapon = inHand ? it : null;
    }
  }
  const wIt = mainWeapon || offWeapon;
  // ★ 空手的 reach 必须【大于】怪的 MOB_REACH(0.055)，
  //   否则怪正好停在攻击范围外 ⇒ 永远够不到 ⇒ 打不死 ⇒ 一局只杀十几只（实测踩过）
  const wDef = wIt ? WEAPON_BY_ID[wIt.weapon]
    : { id: 'fist', name: '空手', reach: 0.085, aoe: 1, dmgMul: 0.70, desc: '没有武器' };
  // 武器伤害系数只作用于"武器加成部分"（避免武器同时改基础攻击导致双算）
  const wMul = wDef.dmgMul;

  // ★ 词缀乘区（层2 §38）：状态 / 时序（同区相加后夹取上界）
  const az = affixZones();
  // ★ 其余词缀（Round 12 接线：此前 13 条是死数据）
  // ★ 其余词缀（Round 12 接线：此前 13 条是死数据）
  //   ⚠️ 必须【按 ID 取实际数值】——曾用 `az.neg === 0.15` 这种字面量比较，
  //      但词缀数值随 ilvl 缩放（A25 在 ilvl60 是 13.6% 不是 10%）
  //      ⇒ 永远不匹配 ⇒ 4 条纯负面词缀完全不生效。
  const negV = id => { const af = AFFIX_BY_ID[id]; return af ? affixValue(af, G._q || 4, 1) : 0; };
  const negP = id => affixNegPct(id);   // 该词缀当前的百分比（已按装备计算）
  const afxNegFreq = 1 - affixNegPct("A24") / 100;      // A24 滞涩：出手频率 −X%
  const afxNegAtk = 1 - affixNegPct("A25") / 100;       // A25 虚弱：全属性 −X%
  const afxNegOrigin = 1 - affixNegPct("A27") / 100;    // A27 枯竭：本源 −X%
  const afxCritTaken = 1 + affixNegPct("A26") / 100;    // A26 破绽：承受暴击 +X%
  const afxPenPct = affixNegPct("A05") / 100;           // A05 穿透：无视 X% 防御
  const afxThorns = negHas("A16") ? 0.05 : 1;           // A16 反伤（固定 5%）
  const afxDfMul = affixHas("A15") ? 1 + affixNegPct("A15") / 100 : 1;   // A15 铁壁：防御 +X%
  const afxHpMul = negHas("A16") ? 1 + affixNegPct("A16") / 100 : 1;     // A16 生命 +X%
  const afxWxOut = softCapMul(1 + az.wxP, 1 + AFFIX_WX_BONUS);   // 玩家打出的相性修正
  const afxWxIn = 1 + az.wxI;                                    // 受击侧的相性抵抗（A09/A10）
  const afxCritDmg = 0, afxPen = 0;   // 占位（保留旧变量名以免删漏）
  // ★ 元素条（A06 火 / A07 水：本命元素对同元素的敌人 +8%）+ A10 破相标记
  //   必须在这里算好 —— 战斗循环里查 AFFIX_BY_ID 会因作用域而拿到 undefined
  const afxBars = {
    火: affixHas('A06') ? 1.08 : 1,
    水: affixHas('A07') ? 1.08 : 1,
  };
  const afxBarsTaken = {
    火: affixHas('A06') ? 1.12 : 1,   // 用火武器 ⇒ 承受水系伤害 +12%
    水: affixHas('A07') ? 1.12 : 1,
  };
  const afxBreakPhase = affixHas('A10');
  const atk = (baseAtk + bonus.攻击 * wMul) * (1 + zoneMod.atk) * gfMods().atk * az.st * afxNegAtk * traitMul('atk');
  const hp = (baseHp + bonus.生命) * gfMods().hp * afxHpMul * traitMul('hp');
  const def = (baseDef + bonus.防御) * (1 + zoneMod.def) * gfMods().def * afxDfMul;
  const _lingbo = (GF.lingboT > 0) ? (1 + P.GF_LINGBO_FREQ) : 1;   // ★ 凌波微步：闪避→提速的触发链
  // ⚠️ 这里【只放负面词缀 A24 滞涩】的系数
  //   曾误写成"az.ti × 负面" ⇒ az.ti 被乘两次；
  //   后又"修"成 afxNegFreq / az.ti ⇒ az.ti 被【抵消】⇒ 时序词缀成了死数据。
  //   正确：az.ti 由 actFreq 表达式乘一次，这里只放负面系数。
  const _afxNegFreq = 1 - affixNegPct('A24') / 100;
  // ★ R61：÷CADENCE ⇒ 出手间隔拉长（每刀伤害在 baseDmg 处 ×CADENCE，DPS 不变）
  const actFreq = P.ACT_FREQ_BASE * Math.pow(P.ACT_FREQ_REALM, realm()) * (1 + zoneMod.freq) * gfMods().freq * az.ti * _lingbo * _afxNegFreq / P.CADENCE;   // az.ti = 时序词缀 · _afxNegFreq = A24 滞涩
  // AOE = 武器基础 + 清场加成 + 品质
  const qBonus = wIt ? Math.floor(wIt.q / 2) : 0;      // 品质给 +0~+2
  const aoe = P.AOE_BASE - 3 + wDef.aoe + Math.floor(bonus.清场 / 200) + qBonus;
  // 攻击范围 = 武器范围（品质越高略微加成，手感上的"精良"）
  const reach = wDef.reach * (1 + (wIt ? wIt.q * 0.02 : 0));

  // ★ 威胁圈：随修为收缩、随难度放大（用户提案）
  const threat = Math.max(P.THREAT_MIN,
    P.THREAT_BASE * Math.pow(P.THREAT_PER_REALM, realm()) * Math.pow(P.THREAT_PER_TIER, G.tier));

  const hitBonus = zoneMod.hit;
  // ★ 闪避：原始值 → 软上限 → 有效值
  //
  //   装备闪避必须【随进度成长】，而且要让"速度流派"能堆到 ~50%
  //   来源（两个都要，只用其一会导致进步空间不够）：
  //     ① 速度类装备的主属性（手/足 的本位主属性 = 速度，随 ilvl/品质增长）
  //     ② 速度向分区修正（"手臂/背"区给的出手频率/清场速度）
  //   ⇒ 全身堆速度 + 站对分区 ⇒ 原始约 60% ⇒ 有效约 52%（有身份可追）
  const gearEvade = Math.min(P.GEAR_EVADE_MAX,
    (bonus.速度 || 0) / 1200 + zoneMod.freq * 0.6);
  const rawEvade = P.WANDER_EVADE + P.EVADE_BASE + gearEvade + gfMods().evade;
  const evade = softEvade(rawEvade);

  // ★ 承压阈值：基础值 + 双腿区修正，再乘【厚实度】
  //
  //   ⚠️ 原来只有"基础 10 + 双腿区修正"，是【所有 build 一样】的。
  //      但那意味着"圈内 15 只"对裸装和堆肉 build 是同样的压力 —— 明显不对。
  //      厚实度 = 本 build 的有效生命 ÷ 裸装基准有效生命
  //      ⇒ 堆防御/血量/闪避的 build 能扛更多只 ⇒ 更敢往怪堆里冲
  //
  //   注意：必须放在 evade 之后（有效生命依赖闪避）
  // ★ 功法属性修正（心法/身法/攻伐/护体/秘术）在下面各处乘入
  const ehpNow = hp / (dmgMul(def) * (1 - evade));
  const baseHp0 = P.HP_BASE * Math.pow(P.R_HP, G.tier);
  const ehpRef = baseHp0 / dmgMul(P.DEF_ANCHOR * Math.pow(P.R_DEF, G.tier));
  const tankiness = Math.max(0.5, ehpNow / Math.max(1, ehpRef));
  const _sgT = activeSignature(wMul);
  const signThresh = (_sgT && _sgT.id === 'S5') ? SIGN_THRESH_ADD : 0;   // 戊土：阈值 +1
  const thresh = Math.round(
    (P.THRESHOLD_R + Math.floor(zoneMod.thresh * P.THRESHOLD_R)) * tankiness) + gfMods().thresh + signThresh;
  // 词缀对出手频率的时序影响（先手/后发/蓄势类）
  const affixFreq = az.ti * afxNegFreq;
  // ★ 主属性：灵根主灵根优先；老存档（无灵根）兜底取主手装备五行，再兜底随机
  const _myWx = lgOf().main
    || (function () {
         for (const z of Object.keys(G.zones)) {
           const zc = G.zones[z];
           for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
             const c = zc.cells[y][x];
             if (c && c._anchor && c.wx) return c.wx;
           }
         }
         return WUXING[0];
       })();
  return {
    atk, hp, def, actFreq,
    aoe: Math.max(1, aoe),
    reach, threat, weapon: wDef,
    // ★ 主属性 = 灵根主灵根（Round 15/16 用户要求："角色主属性按照灵根来和武器无关"）
    //   灵根缺失（老存档）时兜底取"主手装备的五行"，再不行就随机
    wuxing: _myWx, td: tdValue(_myWx), az,
    signature: activeSignature(_myWx),
    evade, rawEvade, gearEvade,
    hitBonus, thresh,
    missRate: Math.max(0, P.HIT.MISS_BASE - hitBonus),
    crit: P.HIT.CRIT_BASE + hitBonus * 0.5,
    ehp: ehpNow, tankiness,
    // ★ 词缀的其余输出（Round 12 接线）
    pen: afxPenPct, thorns: afxThorns, critTaken: afxCritTaken,
    wxOut: afxWxOut, wxIn: afxWxIn, originMul: afxNegOrigin, critDmg: afxCritDmg,
    wxBars: afxBars, wxBarsTaken: afxBarsTaken, breakPhase: afxBreakPhase,
    total: Object.values(bonus).reduce((a, b) => a + b, 0),
  };
}

// ---------------- 五、战斗循环 ----------------
const DT = 0.1;
// ★ 刷怪速率随修为放大
function spawnMul() { return Math.pow(P.SPAWN_TIER_RATE, G.tier); }
function spawnStart() { return P.SPAWN_START * spawnMul(); }
function spawnPeak() { return spawnStart() * P.SPAWN_BURST; }
function rateAt(t) {
  const s0 = spawnStart(), s1 = spawnPeak();
  return t < P.RAMP_TIME ? s0 + (s1 - s0) * t / P.RAMP_TIME : s1;
}

function mobHp() {
  const base = P.MOB_HP_BASE * Math.pow(P.DIFF_MOBHP_RATE, G.tier);
  // ★ 域外天魔：专属敌人更强（血量 ×1.30）
  return invadeActive() ? base * EV_CFG.INVADE_HP : base;
}
// ★ 承压伤害的标定公式（Round 8 定案）
//
// 正确建模：
//   有效生命 EHP = 生命 / (减伤 × (1 − 闪避))
//   承受 DPS    = 每只伤害 × 超压数 × 减伤
//   生存 T      = EHP / DPS = 生命 / (每只伤害 × 超压数 × (1 − 闪避))
//   ⇒ 每只伤害 = 生命 / (超压数 × 减伤 × (1 − 闪避) × T)
//
// 其中「减伤」用【境界基准防御】——怪的强度基准，不随玩家穿装备而变。
//（玩家堆防御的收益体现在 DPS 那一侧的 dmgMul(st.def)，不会重复计算）
//
// ⚠️ 这个常数我调错了两轮，记录踩坑：
//   ① 层 2 的 25 秒出自【旧减伤公式】（防御 200 只减 16.7%），换新公式后失效
//   ② 先写成少了 `mul` 项   ⇒ 生存 50 秒（危险只有一半）
//   ③ 再写成 `mul²`         ⇒ 生存 12.9 秒（危险翻倍）
//   最终以"实测 = 25 秒"为准定死。
// ★ 每只怪的伤害按【玩家实际状态】标定（Round 12 配平修正）
//
//   ⚠️ 原实现只按【修为基准】标定：
//        hp  = P.HP_BASE × R_HP^tier      （不含装备）
//        def = P.DEF_ANCHOR × R_DEF^tier  （不含装备）
//      ⇒ 满装备玩家的有效生命比基准高 ~11 倍，但每只怪的伤害没跟上
//      ⇒ 承压生存窗口从 25 秒漂到 ~280 秒 ⇒ 【玩家从不掉血】
//      （实测：档 24 满装"承压占比 0.0%"、"余血 100%"）
//
//   ⇒ 改为用【玩家真实有效生命】反推：每只伤害 = 有效生命 ÷ (超压数 × 25 秒)
//     这样无论玩家堆了多少防御/血量，"超出阈值 N 只"都恰好对应 25 秒生存窗口。
//   口径：excess = max(0, 圈内怪数 − 阈值)，伤害 = 每只伤害 × excess
//         ⇒ excess = 1 时，恰好撑 SURVIVE_SECONDS(25) 秒
//   口径：threats = 圈内怪数，excess = max(0, threats − 阈值)
//         承压 DPS = 每只伤害 × excess ÷ (1 − 闪避)
//         ⇒ excess 为 1 时，恰好撑 SURVIVE_SECONDS(25) 秒
//   口径：threats = 圈内怪数，excess = max(0, threats − 阈值)
//         承压 DPS = 每只伤害 × excess ÷ (1 − 闪避)
//   ★ 每只伤害【由修为档定值】——不随玩家的防御/血量/装备变化
//     （否则"堆肉"会同时抬高伤害 ⇒ 窗口漂移；见 §危险模型踩坑记录）
function dangerPerMobOf(st) {
  return P.MOB_DMG_BASE * Math.pow(P.MOB_DMG_TIER_RATE, G.tier);
}
function dangerPerMob() {
  // 每只怪的伤害 = 档位定值（与玩家构筑无关）
  const base = P.MOB_DMG_BASE * Math.pow(P.MOB_DMG_TIER_RATE, G.tier);
  // ★ 域外天魔：专属敌人更凶（伤害 ×1.25）
  return invadeActive() ? base * EV_CFG.INVADE_DMG : base;
}
// 由 25 秒目标反推"应该有多少闪避"（保持与其他机制解耦）
function evadeForWindow(mul, perMob) {
  const hp = P.HP_BASE * Math.pow(P.R_HP, G.tier);
  return 1 - perMob * P.OVERLOAD_ASSUMED * mul * mul * P.SURVIVE_SECONDS / hp;
}

// ⚠️ 已删除（Round 17）：原来这里有个"按境界给怪主导五行"的 pickMobWuxing()。
//   职责已被【敌表（五行种类）+ 秘境属性倾向】接管，且它是死代码（无人调用）。
//   删除原因：留着会让人以为"怪的五行走境界"，实际走的是敌表 + 秘境倾向。

// ★ 玩家到某点的距离（用【实际游走位置】，不是固定的中心点）
//   纵向按 0.80 压扁，与绘制一致
const HERO_HOME_X = 0.5, HERO_HOME_Y = 0.56;
function distToHero(e) {
  const dx = e.x - G.heroX, dy = (e.y - G.heroY) / 0.80;
  return Math.hypot(dx, dy);
}
// 威胁圈内（施压中）的怪
function threatsIn(st) { const t = (st || playerStats()).threat; return G.field.filter(e => distToHero(e) <= t); }

// ★ 角色游走（用户提案：站着不动被怪打很怪；走位本身提供闪避）
//   三种运动叠加：
//     ① 常态游走：缓慢走向一个随机目标点，到达后换新目标
//     ② ★ 避怪（Round 9 新增）：目标点向【远离怪群重心】偏移，
//        偏移权重 = 清怪能力越弱越大（用已有的 margin 驱动，不引入新数值）
//     ③ 闪避突进：被闪避触发时，朝【远离最近怪】的方向快速位移一段
function wanderHero(dt) {
  const home = { x: HERO_HOME_X, y: HERO_HOME_Y };

  // ---------- ② 先算"避怪权重"（在选目标点之前）----------
  const st = playerStats();
  G.crowdAvoid = crowdAvoidWeight(st);

  // ---------- ① 常态游走（带避怪偏移）----------
  G.wanderT = (G.wanderT || 0) - dt;
  if (G.wanderT <= 0) {
    G.wanderT = R(1.0, 2.6);
    // 随机方向的落点
    const a = R(0, Math.PI * 2);
    const r = 0.03 + Math.random() * (P.WANDER_RADIUS - 0.03);
    let tx = home.x + Math.cos(a) * r;
    let ty = home.y + Math.sin(a) * r * 0.8;

    // ★ 避怪偏移：把目标点朝"远离怪群重心"的方向拉
    const w = G.crowdAvoid;
    if (w > 0.01 && G.field.length > 0) {
      // 只统计【圈内 + 附近】的怪（远处的怪不影响走位判断）
      let sx = 0, sy = 0, n = 0;
      const scanR = st.threat * 2.2;
      for (const e of G.field) {
        if (distToHero(e) <= scanR) { sx += e.x; sy += e.y; n++; }
      }
      if (n > 0) {
        const cx = sx / n, cy = sy / n;
        // 从重心指向"场地的安全侧"（用当前游走点作为基准，避免贴边）
        let ax = tx - cx, ay = ty - cy;
        let L = Math.hypot(ax, ay);
        if (L < 1e-4) {  // 目标点正好在重心上：改朝中心跑
          ax = home.x - cx; ay = home.y - cy; L = Math.hypot(ax, ay) || 1;
        }
        ax /= L; ay /= L;
        const push = w * P.AVOID_STRENGTH;      // 偏移距离
        tx += ax * push;
        ty += ay * push * 0.8;
        // 夹在场地内
        tx = Math.min(home.x + P.WANDER_RADIUS + P.AVOID_STRENGTH, Math.max(home.x - P.WANDER_RADIUS - P.AVOID_STRENGTH, tx));
        ty = Math.min(home.y + P.WANDER_RADIUS + P.AVOID_STRENGTH, Math.max(home.y - P.WANDER_RADIUS - P.AVOID_STRENGTH, ty));
      }
    }
    G.wanderTarget = { x: tx, y: ty };
  }
  const t = G.wanderTarget;
  {
    const dx = t.x - G.heroX, dy = t.y - G.heroY;
    const d = Math.hypot(dx, dy);
    if (d > 0.004) {
      const sp = Math.min(P.WANDER_SPEED * dt * 6, d);
      G.heroX += dx / d * sp;
      G.heroY += dy / d * sp;
    }
  }

  // ---------- ③ 闪避突进 ----------
  if (G.dashT > 0) {
    G.dashT -= dt;
    let dx = 0, dy = 0, nearest = null, nd = 1e9;
    for (const e of G.field) {
      const d = distToHero(e);
      if (d < nd) { nd = d; nearest = e; }
    }
    if (nearest) {
      dx = G.heroX - nearest.x; dy = G.heroY - nearest.y;
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    } else {
      const a = R(0, Math.PI * 2); dx = Math.cos(a); dy = Math.sin(a);
    }
    const sp = P.DASH_SPEED * dt;
    G.heroX += dx * sp;
    G.heroY += dy * sp;
  }

  // ---------- 边界 ----------
  G.heroX = Math.min(0.88, Math.max(0.12, G.heroX));
  G.heroY = Math.min(0.80, Math.max(0.28, G.heroY));
  {
    const hx = G.heroX - home.x, hy = G.heroY - home.y;
    const hd = Math.hypot(hx, hy);
    const lim = P.WANDER_RADIUS + P.DASH_DIST + P.AVOID_STRENGTH;
    if (hd > lim) {
      const pull = Math.min((hd - lim) * 2.5 * dt, hd - lim);
      G.heroX -= hx / hd * pull; G.heroY -= hy / hd * pull;
    }
  }
  if (G.dodgeFlash > 0) G.dodgeFlash -= dt;
  // ★ Round 43：横幅播报计时（几秒后自动消失）
  if (BANNER_T > 0) {
    BANNER_T -= dt;
    if (BANNER_T <= 0) {
      const _eb = document.getElementById('evBanner');
      if (_eb && _eb.classList) _eb.classList.remove('on');
    }
  }
}

// ★ 避怪权重：清怪能力越弱 ⇒ 权重越大（越躲着怪群走）
//
//   用【已有】的 margin（清场能力 / 刷怪峰值）驱动，不引入新数值：
//     margin ≥ 2.0 → 0.15（碾压，随便逛）
//     margin = 1.4 → 约 0.42（基准）
//     margin = 1.0 → 0.85（勉强够，高度避怪）
//     margin = 0.8 → 0.85（跟不上，最保守）
function crowdAvoidWeight(st) {
  // ⚠️ 这个权重我选错了【三次】指标，全部记录（都是"看起来合理但实测失去区分度"）：
  //   ① 理论 margin（出手频率×AOE÷B÷刷怪峰值）
  //      → 算的是攻击范围【全满】的上限。实测枪理论值 2.13、真实只有 0.84
  //   ② 击杀数 ÷ 全程时长
  //      → 打完时时间被自然拉长，比值恒约 0.84，无法区分强弱
  //   ③ 真实击杀速率 ÷ 刷怪峰值
  //      → 通关的 build 全部恒为 2.52（预算 ÷ 时长锁定），仍然区分不出
  //
  // 正确信号：【承压强度】= 威胁圈内怪数 ÷ 阈值
  //   · 勉强撑住的 build ⇒ 圈内长期贴着/超过阈值 ⇒ 高避怪
  //   · 碾压的 build     ⇒ 圈内几乎空 ⇒ 低避怪
  //   这才是"清怪能力弱 ⇒ 多躲"的真正体现。
  const r = (G.lastPressure != null) ? G.lastPressure : 0.8;   // 首局保守
  let w = (r - 0.25) / 1.15;      // r=0.25→0 · r=1.0→0.65 · r≥1.4→封顶
  if (G.lastSurvived === false) w += 0.2;   // 上局阵亡 ⇒ 更谨慎
  return Math.min(0.85, Math.max(0.15, w));
}

// ★ 灵气：击杀获得修为，满了自动突破
//
//   ⚠️ 一个细节：境界与难度合并后，大境界只在【偶数档】提升。
//      若突破瞬间同时抬小怪难度，会出现"刚变强就被更硬的怪压回去"的割裂感。
//      所以：突破在同一帧里【先抬玩家、再抬小怪】，且灵气/血量同步刷新。
function gainQi(n) {
  // ★ 传道：灵气获取加成
  // ⚠️ 目前只有【传道】真的接线。护道/推演/镇派/登仙 依赖未实现的系统，见 GIFTS 的 pending 字段
  const dao = giftPower('dao');
  if (dao > 0 && n > 0) n = Math.floor(n * (1 + P.GIFT_DAO_RATE * dao));
  // ★ 功法：秘术·炼气化神（灵气获取 +20%）
  const gqi = gfMods().qi;
  if (gqi !== 1 && n > 0) n = Math.floor(n * gqi);
  // ★ 宗门「传功阁」：修炼加速（乘在【本次获得量】上，不能每次给 G.qi 整体乘）
  const sqi = sectBonus().qi;
  if (sqi !== 1 && n > 0) n = Math.floor(n * sqi);
  // ★ 灵根：单灵根修炼快 / 多灵根修炼慢（用户要求：单灵根修炼快）
  const lqi = lgQiMul();
  if (lqi !== 1 && n > 0) n = Math.floor(n * lqi);
  // ★ 道伤：每道 −5% 修为速度（渡劫失败的代价 · Round 20）
  const dqi = dujieQiMul();
  if (dqi !== 1 && n > 0) n = Math.floor(n * dqi);
  // ★ 天赋：影响修炼速度（Round 21 · 用户："越年轻的天赋越高修炼的越快"）
  const tqi = talSpeedMul();
  if (tqi !== 1 && n > 0) n = Math.floor(n * tqi);
  if (G.tier >= P.TIERS - 1) { G.qi = qiNeed(G.tier); return; }   // 满级不再累积
  G.qi += n;
  G.qiTotal += n;
  let guard = 0;
  while (G.qi >= qiNeed(G.tier) && G.tier < P.TIERS - 1 && guard++ < 20) {
    G.qi -= qiNeed(G.tier);
    const before = realm();
      // ★ Round 20：大境界跳 ⇒ 先渡劫（每 2 档一次）
    //   渡劫失败 ⇒ 走火入魔：跌 1 档 + 掉灵气 + 道伤
    if (isRealmBreak(G.tier, G.tier + 1)) {
      const _dj = doDujie();
      if (!_dj.ok) {
        // 失败：本轮突破不再进行（已跌档 / 得道伤）
        if (_dj.retire) { pendingRetire = true; }
        break;
      }
    }
      // ★ Round 21：大境界跳 ⇒ 给寿元（越高的境界给越多）
      {
        const _rl = Math.min(11, Math.ceil((G.tier + 1) / 2));
        if (_rl > (DISCIPLE._lastLifeRealm || 0)) {
          DISCIPLE._lastLifeRealm = _rl;
          grantLifeOnRealm(_rl);
        }
      }
G.tier++;
    G.breakCount++;
    const after = realm();
    // 突破：血量按新上限回满（否则会"变强了但血条还是旧的"）
    const st = playerStats();
    G.hp = st.hp; G.hpMax = st.hp;
    if (after !== before) {
      // ★ Round 35：突破是"变强时刻"的核心 ⇒ 明确带上当时的攻击力
  ev('break', 5, { tier: G.tier, realm: P.REALMS[after], atkAfter: playerStats().atk | 0 });
      log('✦ 突破！' + P.REALMS[before] + ' → ' + P.REALMS[after] +
        // ⚠️ 原来硬编码"+20%"（那是 5 境界 / 每境界 ×1.20 时代的旧值）
        //    现在是【每档】×1.0946，跨大境界是 2 档 ⇒ ×1.198
        '（基础属性 ×' + (P.R_ATK * P.R_ATK).toFixed(3) +
        ' · 小怪同步变强 ×' + P.DIFF_MOBHP_RATE.toFixed(2) + '）', 'break');
      G.fx.push({ x: G.heroX, y: G.heroY - 0.08, txt: '突破！', cls: 'break', life: 1 });
      sfx('break');                        // ★ R60：境界台阶 —— 这是玩家最想听到的声音
      // ★ R62：突破是"变强时刻"，给最大的定格 + 全屏金环
      hitstop(VFX.HIT_BIG);
      skillVfx('突破 · ' + P.REALMS[after], '金', 'flash', { big: true });
      breakoutFlash = 1.2;
    } else {
      log('修为精进：' + P.REALMS[after] + ' 第 ' + (G.tier % P.REALM_PER_TIER + 1) +
        '/2 层（小怪强度 ×' + P.DIFF_MOBHP_RATE.toFixed(2) + '）', 'ok');
      sfx('qi');                           // ★ R60：小台阶给个轻的水泡音
    }
  }
}
let breakoutFlash = 0;

let GIFT_CONSUME_WARD = false;
function startRun() {
  GIFT_CONSUME_WARD = giftOn('ward');
  gfResetRun();   // ★ 功法：清空本局层数（焚心诀/追风步/魂力）
  fbResetRun();   // ★ 法宝：每局每件只能催动 1 次
  const st = playerStats();
  G.hp = st.hp; G.hpMax = st.hp;
  G.running = true; G.phase = 'fight';
  G.t = 0; G.spawned = 0; G.kills = 0; G.elites = 0;
  // ★ 刷怪预算随修为放大（否则高档杀完 780 只就空转 250 秒）
  G.budget = Math.round(spawnPeak() * P.RUN_SECONDS);
  G.budgetBase = G.budget;
  // ★★ Round 34：每局摇一次门规遵守率（整局一致 —— 否则 doctrineScore 排序自相矛盾）
  try { ruleRollReset("run"); } catch (e) { }
  G.field = []; G.actAcc = 0; G.spawnAcc = 0; G.overloadT = 0;
  G.vfxq.length = 0; G.dmgq.length = 0; SFX_Q.length = 0;   // ★ R61：清掉上一局残留的特效/延迟
  G.deathT = null; G.peakField = 0; G.downgraded = 0;
  G.origin = 0;
  G.heroX = 0.5; G.heroY = 0.56; G.wanderT = 0; G.wanderTarget = null;
  G.dodgeAcc = 0; G.dodgeFlash = 0; G.dashT = 0;
  G.mobAtkAcc = 0; G.mobAtkT = 0;   // ★ R210
  G.attackT = 0;                        // ★ Round 36：攻击动画标记
  G.dodgeCount = 0; G.lastDodgeT = -99;
  G.pressureAcc = 0; G.pressureN = 0;
  log('进入秘境 · ' + P.REALMS[realm()] + ' · 难度 ' + (G.tier + 1), 'sys');
}

function tick() {
  // ★ 寿元按【现实时间】流逝（用户决策）—— 无论是否在打都在减少
  //   所以"挂着不管"也在消耗弟子寿命，这才有"抓紧培养"的紧迫感
  const now = Date.now();
  const dtReal = G._lastTick ? (now - G._lastTick) / 1000 : 0;
  G._lastTick = now;
  if (dtReal > 0 && dtReal < 60) {          // 防跳变（切标签页回来时不算）
    DISCIPLE.lifespanLeft -= dtReal;
    tickGifts(dtReal);          // ★ 传承余韵同步流逝
    if (DISCIPLE.lifespanLeft <= 0) {
      DISCIPLE.lifespanLeft = 0;
      endDisciple('old_age');
      render();
      return;
    }
  }
  if (!G.running) return;

  const st = playerStats();
  for (let s = 0; s < 5; s++) {   // 每帧推进 0.5 秒
    if (!G.running) break;
    step(st, DT);
  }
  render();
}
function tickN(n) { const st = playerStats(); for (let i = 0; i < n; i++) { if (!G.running) break; step(st, DT); } render(); }

function step(st, dt) {
  G.t += dt;
  const mh = mobHp();
  const mdef = P.DEF_ANCHOR;
  const dmul = dmgMul(mdef);
  // ★ 五行相性（玩家主属性 vs 具体怪物的属性，逐只判定）
  // ★ R61：每刀伤害 ×CADENCE —— 与出手频率 ÷CADENCE 抵消，**单位时间输出完全不变**
  const baseDmg = st.atk * dmul * P.CADENCE;
  const myEl = st.wuxing;

  // 出怪：★ 从外圈随机方向出生，之后每帧向中央的玩家逼近
  // ★ Round 29：Boss 在场 ⇒ 不再刷小怪（用户要的"清场后 1v1"）
  const _bossOnField = G.field.some(e => e.kind === 'boss');
  if (!_bossOnField) G.spawnAcc += rateAt(G.t) * dt;
  while (!_bossOnField && G.spawnAcc >= 1 && G.spawned < G.budget) {
    G.spawnAcc -= 1; G.spawned++;
    let kind = 'mob';
    // ★ Round 26（用户要求）：精英出现率【随境界】1% → 12%
    //   "现在精英出现的也好少…6.随境界吧1%-12%"
    //
    //   ⚠️ 旧实现 `G.spawned % 150 === 0`（固定间隔）的两个问题：
    //     ① 不随境界 ⇒ 高档预算小（~240）⇒ 最多 1 只
    //     ② 叠加"≤4 刀就降级"⇒ 高档实测【0 只精英】
    //   ⇒ 改为【按境界提高出现率】（补偿被降级的数量）
    const _eliteRate = 0.01 + (0.12 - 0.01) * ((G.tier | 0) / (P.TIERS - 1));
    const _eliteEvery = Math.max(6, Math.round(1 / _eliteRate));
    if (G.spawned % _eliteEvery === 0) kind = 'elite';
    // ★ Boss：局内进度 ≥70% 时出现 1 只（"最后一段"），完全走 AOE 系统
    const _prog = G.budget > 0 ? G.spawned / G.budget : 0;
    // ★ Boss 只在【非入侵】局出现 —— 域外天魔无五行，塞个五行 Boss 会语义冲突
    if (!G.bossSpawned && _prog >= 0.70 && !invadeActive()) {
      kind = 'boss';
      G.bossSpawned = true;
      // ★ Round 29（用户要求："出场的时候清场"）⇒ 清空场上小怪，变成 1v1
      G.field = [];
      G.bossIntro = 1.2;                 // 出场演出倒计时（秒）
      try { log('★ 【Boss 现身】' + (rollBossKind().name || '') + ' —— 小怪尽散', 'break'); } catch (e) { }
      sfx('boss_spawn');                            // ★ R60：全场最响的一个音
      hitstop(VFX.HIT_BIG);                         // ★ R62：Boss 现身定格
      ev('boss_spawn', 10, {});
    }
    // ★ 敌人分类（Round 14/15）：五行 × 形态；精英也有五行（用户要求）
    const isElite = (kind === 'elite');
    const isBoss = (kind === 'boss');
    const mk = rollMobKind(isElite, isBoss);
    // ★ Round 26：精英血量倍率【随境界提高】
    //   ⚠️ 为什么：原固定 3 倍 ⇒ 高档时玩家 2 刀秒小怪、精英也只要 5 刀
    //      ⇒ 触发"≤4 刀就降级"⇒ 精英被降成 mob（还带 3 倍血）⇒ 实测【0 只精英】
    //   ⇒ 让精英始终"值得打"：档1 约 3 倍，满档约 15 倍
    const _eT = (G.tier | 0) / (P.TIERS - 1);
    const eliteHpMul = isElite ? P.ELITE.HP_MUL * (1 + 4 * _eT) : 1;
    const baseMul = isBoss ? mk.hpMul : (isElite ? eliteHpMul : mk.hpMul);
    const hpMul = baseMul;
    const dmgOf = isBoss ? mk.dmgMul : (isElite ? (P.ELITE.DMG_MUL * mk.dmgMul) : mk.dmgMul);
    const hits = mh * hpMul / baseDmg;
    const isTrash = kind === 'elite' && hits <= P.ELITE_DOWNGRADE_HITS;   // Boss 不降级
    if (isTrash) G.downgraded++;
    // ★ R60：精英出场音（被降级成杂兵的【不算】—— 不然没精英也会响）
    if (isElite && !isTrash) sfx('elite_spawn');
    const ang = R(0, Math.PI * 2), rad = R(0.54, 0.66);
    G.field.push({
      kind: isTrash ? 'mob' : kind,
      hp: mh * hpMul, maxHp: mh * hpMul,
      x: 0.5 + Math.cos(ang) * rad,
      y: 0.56 + Math.sin(ang) * rad * 0.80,   // 纵向压扁（画面是宽的）
      hit: 0,
      // ★ 敌人分类（Round 14）—— 修 bug：此前 e.wx 从未赋值
      mk: mk.id, wx: mk.wx, name: mk.name, dmgMul: dmgOf,
    });
  }

  // ★ 角色游走（也会带动威胁圈的位置）
  wanderHero(dt);

  // ★ 敌人向玩家移动（走到各自的近战距离就停）
  for (const e of G.field) {
    const dx = G.heroX - e.x, dy = G.heroY - e.y;
    const d = Math.hypot(dx, dy);
    const stop = e.kind === 'elite' ? P.MOB_REACH + 0.055 : P.MOB_REACH;
    if (d > stop) { const sp = 0.062 * dt; e.x += dx / d * sp; e.y += dy / d * sp; }
    if (e.hit > 0) e.hit -= dt;
  }

  // ★ 出手：AOE 只命中【角色攻击距离内】的目标，优先打最近的
  G.actAcc += st.actFreq * dt;
  let swings = 0;
  while (G.actAcc >= 1 && swings++ < 20) {   // ★ 加保险：单步最多 20 次出手，防死循环
      // ★ Round 36：玩家出手 ⇒ 打攻击动画标记（#hero.attacking，原来从未触发）
      G.attackT = 0.34;
    // ★ R64：候选 = 【几何命中】的怪（扇面 / 溅射），不再是"最近的 N 个"
    const cand = hitCandidates(st);
    if (cand.length === 0) {
      // ★ 范围内没怪 ⇒ 空挥。必须把累积量清零，
      //   否则 while 条件永远成立 ⇒ 死循环（曾把整个页面卡死）
      G.actAcc = 0;
      break;
    }
    G.actAcc -= 1;
    // ★ 秘术·魂力积蕴：满 100 时清场一片（全场 ×3 伤害）
    if (GF._releaseSoul) {
      GF._releaseSoul = false;
      for (const e of G.field) e.hp -= baseDmg * 3;
      G.fx.push({ x: G.heroX, y: G.heroY - 0.14, txt: '魂力爆发', cls: 'crit', life: 1 });
    }
    // ★ 法宝催动判定（玩家预设条件的"底牌"）
    {
      const ctx = {
        threats: G.threats || 0, hpPct: G.hp / Math.max(1, st.hp),
        eliteAlive: G.field.filter(e => e.kind === 'elite').length,
        kills: G.kills, swings: GF.swingW,   // ★ R61：加权出手数 ⇒ 木灵回春『每 25 次』等效时长不变
      };
      // ⚠️ 原来在这里取快照，导致同刻度多件法宝同时触发会把本源扣成负数
      //    改为每次催动前【实时读 G.origin】
      for (const id of FB.eq) {
        const f = FABAO_BY_ID[id];
        if (!f) continue;
        if (G.origin < f.cost) continue;
        if (!fbTriggered(f, ctx)) continue;
        FB.used[f.id] = 1; FB.lastSwing = ctx.swings;
        G.origin -= f.cost;                        // 消耗【本源】
        // 效果按类型结算
        if (f.id === 'f_huguo' || f.id === 'f_muhun') {
          const heal = f.id === 'f_huguo' ? 0.45 : 0.18;
          G.hp = Math.min(st.hp, G.hp + st.hp * heal);
          if (f.id === 'f_muhun') gainQi(30);
        } else {
          const muls = { f_zhuxian: 4, f_huoyu: 3.5, f_binghen: 2, f_jinwu: 6 };
          // ★ 法宝的五行相性：作用于【催动这一击】（与文档"法宝的五行用于相性"一致）
          //   克制时加成、被克时削弱；与玩家主属性的相性独立叠加
          const fbWx = (f.wx && st.wuxing) ? wxMul(f.wx, st.wuxing) : 1;
          const mxBase = muls[f.id] || 2;
          const mx = mxBase * (fbWx > 1 ? P.FB_WX_BONUS : (fbWx < 1 ? P.FB_WX_PENALTY : 1));
          if (fbWx !== 1) {
            G.fx.push({ x: G.heroX, y: G.heroY - 0.20,
              txt: fbWx > 1 ? "属性压制" : "属性受制",
              cls: fbWx > 1 ? "crit" : "miss", life: 1 });
          }
          for (const e of G.field) e.hp -= baseDmg * mx;
        }
        ev('fabao', 6, { name: f.name });
        G.fx.push({ x: G.heroX, y: G.heroY - 0.16, txt: '✦ ' + f.name, cls: 'crit', life: 1 });
        // ★ R62：法宝特效（三类原型 × 五行色）+ 名字横幅 + 顿帧
        skillVfx(f.name, f.wx, FABAO_ARCH[f.id] || 'rays');
        hitstop(VFX.HIT_SKILL);
        log('✦ 法宝催动：' + f.name + '（耗本源 ' + f.cost + '）', 'break');
      }
    }
    // ★ 功法一次出手结算（周期型/释放型）
    //   冲突仲裁：同刻度最多 1 个"占出手"效果（裂空斩优先于天雷引）
    const gfw = gfOnSwing();
    // 心法/秘术的立即效果
    if (gfw.heal > 0 && G.hp > 0) {
      skillVfx(gfw.firedName || '回春', st.wuxing, 'ring');   // ★ R62
      const stH = playerStats();
      G.hp = Math.min(stH.hp, G.hp + stH.hp * gfw.heal);
      G.fx.push({ x: G.heroX, y: G.heroY - 0.06, txt: '回春', cls: 'dodge', life: 1 });
    }
    if (gfw.qi > 0) {
      skillVfx(gfw.firedName || '吐纳', st.wuxing, 'ring');   // ★ R62
      gainQi(gfw.qi);
      G.fx.push({ x: G.heroX, y: G.heroY - 0.04, txt: '+' + gfw.qi + ' 灵气', cls: 'dodge', life: 1 });
    }
    // ★ 吐纳术：停手 X 秒后，下次出手化为【蓄势一击】
    let tunaBurst = false;
    if (gfOn('x_tuna') && GF.idleT >= P.GF_TUNA_IDLE) {
      tunaBurst = true;
      G.fx.push({ x: G.heroX, y: G.heroY - 0.14, txt: '蓄势一击', cls: 'crit', life: 1 });
    }
    GF.idleT = 0;   // 出手即清零（吐纳术 / 焚心诀共用）
    // 攻伐/秘术的"释放型"：本回合改为范围爆发（额外目标 + 伤害倍率）
    let aoeN = st.aoe, dmgMul2 = 1;
    if (tunaBurst) { aoeN += P.GF_TUNA_AOE; dmgMul2 *= P.GF_TUNA_MUL; }
    if (gfw.burst) {
      aoeN = st.aoe + gfw.burst.extra;
      dmgMul2 = gfw.burst.mul;
      skillVfx(gfw.burst.name, st.wuxing, 'rays');   // ★ R62：攻伐/秘术释放型
      hitstop(VFX.HIT_SKILL);
      G.fx.push({ x: G.heroX, y: G.heroY - 0.12, txt: gfw.burst.name, cls: 'crit', life: 1 });
    }
    aoeN += gfw.extraTargets;
    // ★ 金钟罩 / 凝神归元：给护盾（护盾吸收伤害，见受击结算）
    if (gfw.shield > 0) {
      G.shield = Math.max(G.shield || 0, (st.hp || 0) * gfw.shield); G.shieldT = gfw.shieldT;
      skillVfx('护体', st.wuxing, 'ring');   // ★ R62：金钟罩 / 凝神归元
    }
    sfx('swing', 1 + Math.min(0.5, aoeN * 0.04));   // ★ R60：出手（打的目标越多越响一点）
    // ★★ R61：出手的【表现分流】—— 近战出弧光，远程出弹道
    //
    //   设计依据（用户："近战武器至少得看出来看到你砍死怪物，远程的话要有弹道"）：
    //     近战 = 立即命中（无飞行时间）⇒ 手感"贴脸、干脆"
    //     远程 = 有飞行时间 ⇒ 手感"拉开距离"，且天然把"出手"和"命中"分成两个瞬间，
    //            玩家的因果链变成「拉弓 → 箭飞 → 怪中箭」，可读性最高
    //   武器 → 手感映射（纯表现，不影响任何数值）：
    //     剑/刀/枪 → arc 弧光；弓 → arrow 箭矢；杖 → orb 法球
    //   弹道飞行时长 = 距离 × VFX.PROJ_MS_PER_UNIT（弓 reach 0.23 ⇒ 约 290ms，看得见飞）
    const _wid = st.weapon.id;
    const _proj = (_wid === 'bow') ? 'arrow' : (_wid === 'staff' ? 'orb' : null);
    const _hitN = Math.min(aoeN, cand.length);
    // ★ R63：飞行时长按【真实毫秒】算（PROJ_MS_PER_UNIT × 距离）
    const _flyMs = e2 => Math.hypot(e2.x - G.heroX, e2.y - G.heroY) * VFX.PROJ_MS_PER_UNIT;
    if (_proj) {
      for (let k = 0; k < _hitN; k++) {
        const e = cand[k].e;
        G.vfxq.push({
          k: 'proj', kind: _proj, x0: G.heroX, y0: G.heroY, x1: e.x, y1: e.y,
          t0Real: Date.now(), delayMs: _flyMs(e),
        });
      }
    } else if (_hitN > 0) {
      // 近战：弧光朝目标张开，**扇面角 = 实际命中扇面角**、半径 = reach
      //   ⇒ "弧光扫到的就是挨到血的"，不再"扫一大片只掉一只血"
      const _H = WPN_HIT[st.weapon.id] || WPN_HIT_DEF;
      G.vfxq.push({
        k: 'arc', x0: G.heroX, y0: G.heroY, x1: cand[0].e.x, y1: cand[0].e.y,
        t0Real: Date.now(), delayMs: 0, n: _hitN,
        arcDeg: _H.arc, radius: st.reach,
      });
    }
    for (let k = 0; k < aoeN && k < cand.length; k++) {
      const e = cand[k].e;
      if (Math.random() < st.missRate) {
        pushDmgFx(e.x, e.y, 'MISS', 'miss', null,
          (_proj ? _flyMs(e) : 0) + k * VFX.STAGGER_MS);
        sfxDelay('miss', 1, _proj ? 60 : 0);         // ★ R60/R61/R63
        continue;
      }
      // ★ 属性同调乘区：基础攻击之后、随机浮动之前
      // ★ 玩家打出的相性（A08 把上限从 ×1.30 提到 ×1.378）+ 相性条（A06/A07）
      // ★ A05 穿透：无视目标 X% 防御
      const penMul = (st.pen > 0) ? (1 + st.pen) : 1;
      let d = baseDmg * dmgMul2 * tdMul(st.wuxing) * penMul * R(1 - P.DMG_VARIANCE, 1 + P.DMG_VARIANCE);
      // ★ 缩地成寸：必暴窗口内强制暴击
      const isCrit = (GF.critWindow > 0) || (Math.random() < st.crit);
      if (isCrit) d *= 1 + P.HIT.CRIT_DMG_BASE;
      e.hp -= d; e.hit = 0.12;
      // ★ 打出属性克制时，伤害数字加特效（玩家自己会判断相克，不需要提示 UI）
      let wxKe = (myEl && e.wx) ? wxMul(myEl, e.wx) : 1;
    // ★ 神话签名：对【本命克制属性】的敌人 +15%
    const _sg = st.signature;
    if (_sg && e.wx && KE[_sg.wx] === e.wx) wxKe *= (1 + SIGN_KE_BONUS);
      const cls = (isCrit && wxKe > 1) ? 'crit ke'
        : isCrit ? 'crit' : (wxKe > 1 ? 'dmg ke' : 'dmg');
      // ★ R60：命中音。暴击单独一个更亮的音（相克再响一点）
      //   ⚠️ R61：远程的命中音也要等弹道飞到 —— 否则「咻」和「咚」同时响，听起来是没飞
      const _fly = _proj ? _flyMs(e) : 0;
      sfxDelay(isCrit ? 'crit' : 'hit', wxKe > 1 ? 1.25 : 1, _fly);
      if (isCrit) hitstop(VFX.HIT_CRIT);   // ★ R62：暴击顿帧（远程要等弹道飞到才顿）
      // ★ R61：飘字错开 —— 同一次出手打多个目标时，逐个错开 STAGGER 出现，
      //   否则 5 个数字同帧糊在一起（实测单刀最多结算 5 个目标）
      pushDmgFx(e.x, e.y, Math.round(d) + (isCrit ? '!' : ''), cls,
        wxKe > 1 ? myEl : null, _fly + k * VFX.STAGGER_MS);
    }
    for (let k = G.field.length - 1; k >= 0; k--) {
      if (G.field[k].hp <= 0) {
        if (G.field[k].kind === 'elite') {
          G.elites++;
          G.fx.push({ x: G.field[k].x, y: G.field[k].y, txt: '精英击杀', cls: 'crit', life: 1 });
          sfx('kill_elite');                        // ★ R60：精英死亡，值得听见
          hitstop(VFX.HIT_ELITE);                   // ★ R62
        } else if (G.field[k].kind === 'boss') {
          sfx('kill_boss');                         // ★ R60：Boss 倒下
          hitstop(VFX.HIT_BIG);                     // ★ R62：一局只有一次，砸出来
        } else {
          // ★ R60：小怪死亡音按【形态】分组（重装/迅捷/标准/磨/秒）——
          //   全库 54 个敌人音，按形态分才既有变化又不杂乱
          sfx(SFX_FORM[G.field[k].form] || 'kill_std');
        }
        const dead = G.field[k];
        G.kills++; G.totalKills++;
        // ★ A27 枯竭：本源获取 −X%
        const _om = (G._lastSt && G._lastSt.originMul) || 1;
        G.origin += P.ORIGIN_PER_KILL * _om;
        // ★ 灵气：击杀获得修为（精英给更多）
        gfOnKill();   // ★ 功法：心法层数 / 身法层数 / 魂力
        GF.holdT = 0;                       // ★ 焚心诀：击杀即续命
        // ★ 域外天魔：每只怪额外给荣誉点（事件的"额外收益"）
        if (invadeActive()) {
          SECT.honor += EV_CFG.INVADE_HONOR_PER_KILL;
          G.evHonor = (G.evHonor || 0) + EV_CFG.INVADE_HONOR_PER_KILL;
        }
        if (gfOn('m_lianqi') && G.kills % P.GF_LIANQI_PER === 0) {
          gainQi(P.GF_LIANQI_QI);           // ★ 炼气化神：事件型加算（不是全局乘性）
          G.fx.push({ x: G.heroX, y: G.heroY - 0.06, txt: '+' + P.GF_LIANQI_QI + ' 灵气', cls: 'dodge', life: 1 });
        }
        rollGongfaDrop();   // ★ 功法掉落 → 背包（用户要求：手动装）
        rollFabaoDrop();    // ★ 法宝掉落 → 背包
        gainQi(dead && dead.kind === 'elite' ? P.QI_PER_ELITE : P.QI_PER_KILL);
        G.field.splice(k, 1);
        // ★ 实时掉落：杀掉就有机会掉（挂机刷宝的核心反馈）
        rollDrop(dead);
      }
    }
  }

  // ★ 承压伤害：只算【威胁圈内】的怪，且被闪避减免
  //   闪避的实现：不是"每次攻击掷骰"，而是【按速率随机免伤】
  //   —— 视觉上等价于"走位躲开了"，且不会因为掷骰频率改变平衡
  // ★ 加权威胁（Round 14）：威胁值 = Σ(形态伤害倍率)，而不是"数怪数"
  //   这样"重装/迅捷"（×0.90 / ×1.12）能真正体现在承压上。
  //   相性在下面单独作用于伤害（反向相性），不重复计入威胁值。
  const threatW = G.field.reduce((n, e) =>
    n + (distToHero(e) <= st.threat ? (e.dmgMul || 1) : 0), 0);
  const threatN = G.field.reduce((n, e) => n + (distToHero(e) <= st.threat ? 1 : 0), 0);
  G.threats = threatW;          // 承压用加权值
  G.threatsN = threatN;         // 实际只数（供显示 / 测试）
  const threats = threatN;
  if (st.thresh > 0) { G.pressureAcc += threatW / st.thresh; G.pressureN++; }
  if (threatW > st.thresh) {
    const excess = threatW - st.thresh;
    // ★ 五行相性·反向：怪物打玩家也按相性结算（层 1 §5.2「双向生效」）
  //   取【圈内怪的相性均值】，避免逐只结算导致的抖动
  let wxIn = 1;
  if (threats > 0 && myEl) {
    // 按【加权威胁】取相性均值（与上面 threatW 同权重，避免抖动）
    let sum = 0, wsum = 0;
    for (const e of G.field) {
      if (distToHero(e) <= st.threat) {
        const w = (e.dmgMul || 1);
        sum += wxMul(e.wx, myEl) * w; wsum += w;
      }
    }
    if (wsum > 0) wxIn = sum / wsum;
    // ★ A09 五行·御：抵抗被克伤害 +X%
    if (wxIn > 1) wxIn *= Math.max(0.5, 2 - (st.wxIn || 1));
    // ★ A10 破相：敌人对你的克制优势减半（用户决策 A：削弱怪对玩家的相性倍率）
    if (st.breakPhase && wxIn > 1) wxIn = 1 + (wxIn - 1) * 0.5;
    // ★ A06/A07 的代价：用火/水武器时承受相克元素更多伤害
    const barTaken = (st.wxBarsTaken && st.wxBarsTaken[myEl]) || 1;
    wxIn *= barTaken;
  }
  const _sgIn = st.signature;
  const signTaken = (_sgIn && _sgIn.id === 'S3') ? SIGN_TAKEN_MUL : 1;   // 玄水：受击 −8%
  const rawDps = dangerPerMob() * excess * dmgMul(st.def) * wxIn * gfMods().dmgTaken * signTaken;
    const dodged = rawDps * st.evade;
    const dps = rawDps - dodged;
    const before = G.hp;
    // ★ 护盾：先吸收伤害（金钟罩 / 凝神归元）
    let dpsAfterShield = dps;
    if ((G.shield || 0) > 0) {
      const absorbed = Math.min(G.shield, dps * dt);
      G.shield -= absorbed;
      dpsAfterShield = (dps * dt - absorbed) / Math.max(1e-6, dt);
      if (G.shield <= 0) G.shield = 0;
    }
    // ★ A16 血煞：反伤（按承压伤害的一定比例回敬圈内的怪）
    if ((st.thorns || 0) > 0 && threats > 0) {
      const refl = dpsAfterShield * dt * st.thorns / Math.max(1, threats);
      for (const e of G.field) { if (distToHero(e) <= st.threat) e.hp -= refl * 8; }
    }
    // ★★ R210：连续承压伤害 → "某几只怪扑上来咬一口"
    //   伤害积分不变（累加后一次性结算），但每一次伤害都有【可见的出手者】。
    G.mobAtkAcc += dpsAfterShield * dt;
    G.mobAtkT += dt;
    if (G.mobAtkT >= P.MOB_ATK_CD) {
      G.mobAtkT -= P.MOB_ATK_CD;
      const _dmg = G.mobAtkAcc; G.mobAtkAcc = 0;
      if (_dmg > 0) {
        // 出手者 = 威胁圈内最近的 N 只（它们才是压上来的那些）
        const _atk = G.field
          .map(function (e) { return { e: e, d: distToHero(e) }; })
          .filter(function (x) { return x.d <= st.threat && x.e.hp > 0; })
          .sort(function (a, b) { return a.d - b.d; })
          .slice(0, P.MOB_ATK_MOBS);
        G.hp -= _dmg;
        G.dmgTaken = (G.dmgTaken || 0) + _dmg;
        // 每只分摊一份（总和严格等于这一拍的全部伤害 ⇒ 不改配平）
        const per = _atk.length ? _dmg / _atk.length : 0;
        for (let ai = 0; ai < _atk.length; ai++) {
          const ae = _atk[ai].e;
          ae._lungeUntil = Date.now() + P.MOB_LUNGE_MS;      // 表现：扑击（render 消费）
          if (per >= 1) {
            pushDmgFx(ae.x, ae.y + 0.05, '-' + Math.round(per), 'player', null, 0);
          }
        }
        if (!_atk.length) pushDmgFx(G.heroX, G.heroY + 0.14, '-' + Math.round(_dmg), 'player', null, 0);
        sfxDelay('hurt', 1, 0);
      }
    }
    G.overloadT += dt;
    G.hitT = P.GF_JINGANG_SEC;   // ★ 受击标记（金刚体：受击后抬阈值）
    // ★ 功法计时
    GF.idleT += dt; GF.holdT += dt;
    // ★ 主动技能的持续时间递减
    if (G.shieldT > 0) { G.shieldT -= dt; if (G.shieldT <= 0) { G.shieldT = 0; G.shield = 0; } }
    G.hitT = Math.max(0, (G.hitT || 0) - dt);
    // 焚心诀：停手超时 ⇒ 层数按秒衰减
    if (GF.idleT > P.GF_FASHI_HOLD_SEC && GF.killStack > 0) {
      GF.killStack = Math.max(0, GF.killStack - Math.ceil(GF.killStack * dt));
    }
    // ★ 闪避的视觉反馈：累计"躲掉的血量"到一定量就闪一下 + 飘"DODGE"
    G.dodgeAcc = (G.dodgeAcc || 0) + dodged * dt;
    if (G.dodgeAcc > st.hp * 0.05) {
      G.dodgeAcc = 0;
      // ★ R65：dodgeFlash 原来 0.35【游戏秒】= 真实 150ms，太短看不清
      G.dodgeFlash = VFX.DODGE_MS / 1000 * 2.33;
      G.dashT = P.DASH_TIME;                 // ★ 触发突进
      // ★ R65：残影 —— 朝突进方向拖出 3 个立绘残影（在 G.dashT 结算前先求出方向）
      {
        let ddx = 0, ddy = 0, nz = null, nd2 = 1e9;
        for (const e of G.field) { const d = distToHero(e); if (d < nd2) { nd2 = d; nz = e; } }
        if (nz) { const l = Math.hypot(G.heroX - nz.x, G.heroY - nz.y) || 1;
          ddx = (G.heroX - nz.x) / l; ddy = (G.heroY - nz.y) / l; }
        else { const a = Math.random() * Math.PI * 2; ddx = Math.cos(a); ddy = Math.sin(a); }
        G.vfxq.push({ k: 'ghost', x0: G.heroX, y0: G.heroY, dx: ddx, dy: ddy,
          t0Real: Date.now(), delayMs: 0 });
      }
      if (gfOn('s_lingbo')) GF.lingboT = P.GF_LINGBO_WINDOW;   // ★ 凌波微步：闪避→提速
      G.dodgeCount++; G.lastDodgeT = G.t;    // ★ 身法钩子
      G.fx.push({ x: G.heroX, y: G.heroY - 0.05, txt: '闪避', cls: 'dodge', life: 1 });
      sfx('dodge');                          // ★ R60
    }
    G.hurtAcc = (G.hurtAcc || 0) + (before - G.hp);
    if (G.hurtAcc > st.hp * 0.06) {
      G.hurtAcc = 0; G.shake = 0.2;
      G.fx.push({ x: G.heroX, y: G.heroY + 0.14, txt: '-' + Math.round(dps * 0.4), cls: 'player', life: 1 });
      sfx('hurt');                           // ★ R60：挨打了要听得见（这条比命中音更重要）
    }
    if (G.hp <= 0) { G.hp = 0; endRun(false); return; }
  }

  // 飘字寿命 / 抖动衰减
  for (let i = G.fx.length - 1; i >= 0; i--) { G.fx[i].life -= dt * 1.8; if (G.fx[i].life <= 0) G.fx.splice(i, 1); }
  if (G.shake > 0) G.shake -= dt;
  if (G.fx.length > 24) G.fx.splice(0, G.fx.length - 24);
  vfxTick();      // ★ R61：推进表现层（延后的飘字/命中音到点放出来）

  // ★★ Round 30 修复（用户报："第一代弟子背包一堆装备，不装身上直接死了"）
  //   ⚠️ 原来 assembleBest() **只在 endRun 里调用** ⇒ 弟子【整局裸奔】！
  //     实测：第一局 50 秒背包 10 件·身上 0 件；150 秒背包 50 件·身上 0 件
  //     ⇒ 第一代弟子撑不到局末 ⇒ 穿着 0 件就死了，背包里一堆装备没用上
  //   ⇒ 改为【局内也自动穿】+ 1 秒节流（assembleBest 是装箱算法，不能每帧跑）
  G._autoEqT = G._autoEqT || 0;
  if (G.t - G._autoEqT >= 1.0) {
    G._autoEqT = G.t;
    try { assembleBest(); } catch (e) { G._assembleErr = (G._assembleErr || 0) + 1; }
    // ★ Round 31：功法和法宝也要【局内及时装上】（用户："功法也记得及时装上，法宝也是"）
    try { autoLearnSpecs(); } catch (e) { }
    try { autoPickSpecs(); } catch (e) { }     // 法宝：槽满时挑最合适的
  }
  G.peakField = Math.max(G.peakField, G.field.length);

    if (G.spawned >= G.budget && G.field.length === 0) endRun(true);
}

// ★ 实时掉落：每次击杀按概率掉一件
//   （原来只在结算时一次性掉，所以打到一半看不到任何东西）
function rollDrop(dead) {
  const isElite = dead && dead.kind === 'elite';
  const isBoss = dead && dead.kind === 'boss';
  const p = DROP.PER_KILL * (isBoss ? 8 : (isElite ? DROP.ELITE_MULT : 1)) * traitMul('drop');
  if (Math.random() >= p) return;
  sfx(isBoss ? 'kill_boss' : (isElite ? 'equip' : 'drop'));   // ★ R60：出货了
  const ilvl = 1 + G.tier * DROP.ILVL_PER_TIER;
  const it = makeItem(ilvl, null);
  G.dropped++;
  // 第 1 层：自动过滤（低于阈值直接分解）
  if (it.q < G.filterQ) {
    G.disenchanted++;
    SECT_RES.materials += disenchantValue(it);
    return;
  }
  it._gain = upgradeDelta(it).ratio;
  it._new = true;
  it._t = Date.now();
  G.bag.push(it);
  // 掉落提示（飘字 + 日志）
  //
  //   ★ Round 24（用户要求）：「录」页是【角色生平】，不该被普通装备掉落淹没
  //     "角色生平肯定是看他经历了什么，获得了什么好东西，
  //      你普通装备写进去干什么"
  //
  //   ⇒ 日志只记【真正的好东西】：
  //       神话（q4）+ 签名  ⇒ 记（这是传承级的东西）
  //       传奇（q3）        ⇒ 不记（高档时满地都是）
  //       史诗/精良/普通    ⇒ 不记
  //   ⇒ 事件系统（EVENTS / 挂机报告）仍记录 q3，只是不占日志
  if (it.q >= 3) ev(it.q >= 4 ? 'drop_myth' : 'drop_legend', it.q >= 4 ? 9 : 6, { slot: it.slot, q: it.q, nm: it.name, wp: it.weapon });
  if (it.q >= 4 && it.sig && SIGNATURE_BY_ID[it.sig]) {
    log('✦ 得【神话·' + (it.name || SLOT_NOUN[it.slot] || it.slot) + '】' + SIGNATURE_BY_ID[it.sig].name +
      '（' + it.kind + '+' + it.mainVal + '）', 'break');
  }
  // 背包上限保护
  const BAG_MAX = 60;
  if (G.bag.length > BAG_MAX) {
    let worst = 0;
    for (let i = 1; i < G.bag.length; i++) {
      if ((G.bag[i]._gain || 0) < (G.bag[worst]._gain || 0)) worst = i;
    }
    SECT_RES.materials += disenchantValue(G.bag[worst]);
    G.disenchanted++;
    G.bag.splice(worst, 1);
  }
}

function endRun(survived) {
  G.running = false; G.phase = 'rest';
  G.runs++;
  DISCIPLE.runs++;
  ev('run', 2, { survived: survived, kills: G.kills });
  // ★ Round 18：用不上的装备全部分解 → 素材回宗门
  //   用户原话："多出来的装备全部分解，变成素材，后面素材待会宗门"
  { autoScrapByDoctrine(); }
  // ★ 秘境属性倾向：每局换一个秘境（弟子换地方历练）
  { const _zb = zbAdvance(); ev('zone', 3, { name: _zb.name, wx: _zb.wx }); }
  // ★ 事件系统：每局结束推进日历（比武擂台 / 域外天魔）
  {
    const _ev = evTickRun();
    if (_ev) EVENT.active = _ev;
    // 比武擂台：自动参加（零操作）—— 立刻结算，名次进挂机报告
    if (EVENT.active && EVENT.active.type === "tourney") {
      evRunTourney(playerStats());
      EVENT.active = null;
    }
  }
  saveGame();
  // ★ 搜寻机制：每局结束推进；空闲且有待取回的遗落就发起
  tickSearch();
  if (!SEARCH.active && SECT.lostLegacy.length > 0 && G.runs % 2 === 0) startSearch();
  DISCIPLE.peakTier = Math.max(DISCIPLE.peakTier, G.tier);
  // ★ 战斗身亡：传承遗落（弟子结束）
  if (!survived) {
    // ★ 护佑（封存档给赠）：首次致命伤免疫，触发即消耗
    if (GIFT_CONSUME_WARD) {
      GIFT_CONSUME_WARD = false;
      GIFTS_ACTIVE.ward = { quiet: 0, phase: 3, layers: 0, powerLayers: 0 };
      G.hp = Math.max(1, Math.round(playerStats().hp * 0.3));
      ev('ward_used', 7, {});
      log('✦ 护佑发动 · 致命一击被挡下（护佑已消耗）', 'break');
      G.running = true; G.phase = 'fight'; G.deathT = null;
      return;
    }
    setTimeout(() => { endDisciple('battle'); render(); }, 1500);
    // 仍然走下面的掉落与日志，让玩家看到"死前掉了什么"
  }
  // 掉落已在战斗过程中实时结算（见 rollDrop）
  // 结算时只补一次"通关保底"
  let bonus = 0;
  if (survived) {
    const ilvl = 1 + G.tier * DROP.ILVL_PER_TIER + DROP.ILVL_WIN_BONUS;
    for (let i = 0; i < DROP.MIN_ON_WIN; i++) {
      const it = makeItem(ilvl, null);
      G.dropped++;
      if (it.q < G.filterQ) { G.disenchanted++; SECT_RES.materials += disenchantValue(it); continue; }
      it._gain = upgradeDelta(it).ratio;
      it._new = true; it._t = Date.now();
      G.bag.push(it);
      bonus++;
    }
  }
  // ★ Round 23：自动换装（按【训话 + 门装模板】）
  //
  //   ⚠️ 原来这段被误放在【通关掉落循环内部】，导致：
  //     ① 只在 survived 时换装（阵亡局永远不换）
  //     ② 每件掉落都判定一次（靠 6 秒节流兜住，但语义是错的）
  //   ⇒ 移到循环外，且【每局结束都换】（不论胜负）
  {
    G._assembleT = Date.now();
    try {
      const _ab = assembleBest();
      if (_ab && (_ab.changed || _ab.scrapped)) {
        G._lastAssemble = _ab;
        // ★ Round 24：换装【必须可见】—— 用户反馈"我没看到装备更换啊"
        //   原来自动换装完全静默 ⇒ 玩家以为功能没实现
        if (_ab.changed > 0) {
          log('✦ 自行换装 ' + _ab.changed + ' 件' +
            (_ab.scrapped ? ' · 分解 ' + _ab.scrapped + ' 件' : ''), 'ok');
        }
      }
    } catch (e) { G._assembleErr = (G._assembleErr || 0) + 1; }
  }
  // ★ 自动学功法/法宝（弟子自己挑，不用玩家手点）
  //   用户："弟子会自动穿装备，选择对应功法？"
  try { autoLearnSpecs(); } catch (e) { G._specErr = (G._specErr || 0) + 1; }
  // ★ Round 29：Boss 击杀 ⇒ 记一笔（用户："做个boss出来"）
  if (G.bossKilled && !G._bossLogged) {
    G._bossLogged = true;
    log('★ 本局讨伐 Boss 成功（掉落 ×8）', 'break');
  }

  // ★ 记录本局【真实击杀速率】（用于下一局的避怪权重）
  //
  //   ⚠️ 不能用"击杀数 ÷ 全程时长"：打完时时间被自然拉长，
  //      该比值恒约 0.84，无法区分强弱（踩过这个坑）。
  //      要用【击杀速率】的绝对值，并与刷怪峰值比较。
  if (G.t > 5) G.lastKillRate = G.kills / G.t;
  if (G.pressureN > 0) G.lastPressure = G.pressureAcc / G.pressureN;   // ★ 承压强度
  G.lastSurvived = survived;
  log((survived ? '✅ 通关' : '💀 阵亡') + ' · 击杀 ' + G.kills +
    ' · 掉落 ' + G.dropped + ' 件' +
    (bonus ? '（含通关保底 ' + bonus + '）' : '') +
    (G.disenchanted ? ' · 已分解 ' + G.disenchanted : '') +
    ' · 本源 +' + G.origin,
    survived ? 'ok' : 'bad');
  render();
  setTimeout(() => { if (G.phase === 'rest') startRun(); }, 2200);
}

// ---------------- 五之二、建指纹与「换上去会怎样」 ----------------
//
// 设计依据：装备与掉落.md §7.2
//   第 2 层「值得一看的标记」：标出"这件比你身上的强"，但【只标差异，不标结论】
//   第 3 层「一眼可比」：显示"换上去之后"的六项属性变化
//
// 实现：把当前穿戴拍成指纹 → 试放新装备 → 重算属性 → 与基线比 delta
//       候选位置全部试一遍，取"综合战力最高"的那个（真实最优摆放）

// 把已穿戴装备抽成 {slot, q, shape, cells, kind, mainVal, home} 列表
function buildFingerprint() {
  const list = [];
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (c && c._anchor) {
        const it = {}; for (const k in c) if (k !== '_anchor' && k !== '_part' && k !== 'ref') it[k] = c[k];
        it._zone = z;                 // 记录它现在在哪个区
        list.push(it);
      }
    }
  }
  return list;
}

// 综合战力（用于排序与"最优摆放"的判据）
// 刻意做成【单一标量】仅供内部排序；玩家看到的仍是六项并列（不给单一结论）
function combatValue(st) {
  const dmgOut = st.atk * st.actFreq * (st.aoe / P.AOE_BASE);
  const survive = st.ehp;
  return Math.sqrt(Math.max(1, dmgOut) * Math.max(1, survive));
}

// 用一份装备列表算属性（不碰 G.zones）
function statsOfLayout(list) {
  // ⚠️ 用修为档，与 playerStats 一致（否则"预览配装"和实际属性会对不上）
  const baseAtk = P.ATK_BASE * Math.pow(P.R_ATK, G.tier);
  const baseHp = P.HP_BASE * Math.pow(P.R_HP, G.tier);
  const baseDef = P.DEF_ANCHOR * Math.pow(P.R_DEF, G.tier);
  const bonus = { 攻击: 0, 防御: 0, 生命: 0, 速度: 0, 命中: 0, 承压: 0, 清场: 0 };
  const zm = { atk: 0, def: 0, freq: 0, hit: 0, thresh: 0, clear: 0 };
  const homeIn = {};
  for (const it of list) {
    const z = it._placedZone;
    if (!z) continue;
    const p = itemPower(it, z);
    for (const k of Object.keys(bonus)) bonus[k] += p[k] || 0;
    if (z === it.home) homeIn[z] = true;
  }
  for (const z of Object.keys(homeIn)) {
    const m = ZONE_MOD[z];
    if (m.stat === '攻击力') zm.atk += m.add;
    if (m.stat === '防御') zm.def += m.add;
    if (m.stat === '出手频率') zm.freq += m.add;
    if (m.stat === '命中与暴击') zm.hit += m.add;
    if (m.stat === '承压阈值') zm.thresh += m.add;
    if (m.stat === '清场速度') zm.clear += m.add;
  }
  const atk = (baseAtk + bonus.攻击) * (1 + zm.atk);
  const hp = baseHp + bonus.生命;
  const def = (baseDef + bonus.防御) * (1 + zm.def);
  const actFreq = P.ACT_FREQ_BASE * Math.pow(P.ACT_FREQ_REALM, realm()) * (1 + zm.freq);
  const aoe = Math.max(2, P.AOE_BASE + Math.floor(bonus.清场 / 200));
  return {
    atk, hp, def, actFreq, aoe,
    crit: P.HIT.CRIT_BASE + zm.hit * 0.5,
    missRate: Math.max(0, P.HIT.MISS_BASE - zm.hit),
    hitBonus: zm.hit,
    thresh: P.THRESHOLD_R + Math.floor(zm.thresh * P.THRESHOLD_R),
    ehp: hp / dmgMul(def),
  };
}

// 把一份装备列表按分区容量装箱（贪心：同区先放大的）
function packLayout(list, extra) {
  const zones = {};
  for (const z of Object.keys(ZONE_CAP)) {
    const cap = ZONE_CAP[z][realm()];
    const [w] = ZONE_RECT[z];
    const h = zoneH(z, cap);
    zones[z] = { w, h, used: 0, cap };
  }
  // 按"格数降序"尝试放入（大件优先，避免小件占位导致大件放不下）
  const all = list.concat(extra ? [extra] : []);
  const placed = [], unplaced = [];
  for (const it of all.slice().sort((a, b) => b.cells - a.cells)) {
    let best = null;
    for (const z of Object.keys(zones)) {
      const zz = zones[z];
      if (zz.used + it.cells > zz.cap) continue;
      // 形状要装得进矩形
      const [iw, ih] = it.shape;
      const [rw, rh] = [zz.w, zz.h];
      const fit = (iw <= rw && ih <= rh) || (ih <= rw && iw <= rh);
      if (!fit) continue;
      // 评分：本位区优先，其次剩余空间利用
      const same = (it.home === z) ? 1 : 0;
      const sc = same * 1000 - zz.used;
      if (!best || sc > best.sc) best = { z, sc };
    }
    if (best) { zones[best.z].used += it.cells; placed.push(Object.assign({}, it, { _placedZone: best.z })); }
    else unplaced.push(it);
  }
  return { placed, unplaced };
}
function zoneH(z, cap) {
  const [w] = ZONE_RECT[z];
  return Math.max(1, Math.ceil(cap / w));
}

// ★ 核心：评估"如果把 it 穿上，属性会怎么变"
//   返回 { gain, layout, before, after, bestZone }
function evaluateSwap(it) {
  const cur = buildFingerprint();
  const before = statsOfLayout(cur.map(x => Object.assign({}, x, { _placedZone: x._zone })));
  // 基线：把当前穿戴重新装箱（保证与候选同口径）
  const basePack = packLayout(cur);
  const b0 = statsOfLayout(basePack.placed);
  // 候选：加入新装备后重新装箱
  const newPack = packLayout(cur, it);
  const a0 = statsOfLayout(newPack.placed);
  const v0 = combatValue(b0), v1 = combatValue(a0);
  const delta = {};
  for (const k of ['atk', 'hp', 'def', 'actFreq', 'aoe', 'crit', 'thresh']) {
    delta[k] = a0[k] - b0[k];
  }
  // 它被放到了哪个区
  const mine = newPack.placed.find(p => p.id === it.id);
  return {
    before: b0, after: a0, delta,
    gain: (v1 / Math.max(1, v0) - 1),      // 综合提升比例
    bestZone: mine ? mine._placedZone : null,
    equipped: !!mine,
    disenchanted: !mine,
  };
}


// ---------------- 五之三、放置逻辑（实际落格） ----------------
function canPlace(it, zone, gx, gy) {
  const zc = G.zones[zone];
  if (!zc) return false;
  const [w, h] = it.shape;
  if (gx + w > zc.w || gy + h > zc.h) return false;
  // 容量检查
  let used = 0;
  for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
    const c = zc.cells[y][x];
    if (c && typeof c === 'object' && c._anchor) used += c.cells;
  }
  if (used + it.cells > zoneCap(zone)) return false;
  for (let y = gy; y < gy + h; y++) for (let x = gx; x < gx + w; x++) {
    if (zc.cells[y][x]) return false;
  }
  return true;
}
function place(it, zone, gx, gy) {
  const zc = G.zones[zone];
  const [w, h] = it.shape;
  for (let y = gy; y < gy + h; y++) for (let x = gx; x < gx + w; x++) {
    zc.cells[y][x] = (x === gx && y === gy) ? Object.assign({ _anchor: true }, it) : { _part: true, ref: it };
  }
}
// ★ 卸下一件装备并放回背包
//   用户反馈：原来没有"卸下单件"的操作，装备从装备区拿下来就丢了
function unequipAt(zone, gx, gy) {
  const it = removeFromZone(zone, gx, gy);
  if (!it) return null;
  G.bag.push(Object.assign({}, it, { _anchor: undefined, _part: undefined, _gain: null, _new: false }));
  log("卸下 " + itemNameQ(it), "sys");
  render();
  return it;
}

function removeFromZone(zone, gx, gy) {
  const zc = G.zones[zone];
  const c = zc.cells[gy][gx];
  if (!c || !c._anchor) return null;
  const [w, h] = c.shape;
  const it = {}; for (const k in c) if (k !== '_anchor' && k !== '_part') it[k] = c[k];
  for (let y = gy; y < gy + h; y++) for (let x = gx; x < gx + w; x++) zc.cells[y][x] = null;
  // 其他装备的引用也要清（若重叠）
  return it;
}

// ---------------- 七、渲染 ----------------
const $ = s => document.querySelector(s);
// 寿元格式化
// ★ 寿元显示：HUD 用【年数】，悬停提示用【现实时间】（用户要求）
//   3 小时现实时间 = 一生 = 100 年 ⇒ 1 小时 ≈ 33.3 年
function lifeToYears(sec) {
  // ★ Round 21：用 lifeMax 当分母（寿元会因突破增长，写死 3 小时会失真）
  if (sec <= 0) return 0;
  return Math.max(0, Math.round(sec / (P.LIFESPAN_HOURS * 3600) * P.LIFESPAN_YEARS));
}
// 现实时间（悬停提示用）
function fmtLifeReal(sec) {
  if (sec <= 0) return "寿元已尽";
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h > 0 ? (h + " 小时 " + m + " 分") : (m + " 分 " + Math.floor(sec % 60) + " 秒");
}
// 兼容旧调用：现在返回年数
function fmtLife(sec) {
  if (sec <= 0) return "寿元已尽";
  return lifeToYears(sec) + " 年";
}

// ★★ Round 43：把指定代的生平记录快照进 SECT.chronicle
//   ⚠️ G.log 上限 60 条且不进存档 ⇒ 弟子死时必须立刻抓住这一代的记录
//   ⚠️ 去重：log() 里 t 是 Date.now()，同一毫秒可能重复 ⇒ 用 t+msg 做键
function snapshotChronicle(gen) {
  if (gen == null) return 0;
  const mine = G.log.filter(function (l) { return l.gen === gen; });
  if (!mine.length) return 0;
  const old = SECT.chronicle[gen] || [];
  const seen = {};
  for (const l of old) seen[l.t + '|' + l.msg] = 1;
  const merged = old.slice();
  for (const l of mine) {
    const k = l.t + '|' + l.msg;
    if (seen[k]) continue;
    seen[k] = 1;
    merged.push({ msg: l.msg, cls: l.cls || '', t: l.t });
  }
  merged.sort(function (a, b2) { return a.t - b2.t; });
  SECT.chronicle[gen] = merged.slice(-80);      // 每代最多留 80 条
  // 只保留最近 20 代
  const keys = Object.keys(SECT.chronicle).map(Number).sort(function (a, b2) { return a - b2; });
  while (keys.length > 20) { delete SECT.chronicle[keys.shift()]; }
  return merged.length;
}

// ★★ Round 43：横幅播报（擂台战果 / 宗门大事）
//   用户："就像正常网游一个横幅播报一下，保存到史册馆的生平就行"
//   ⇒ 播报 = 屏幕顶部一条横幅（几秒后消失）
//      同时 log() 一条 ⇒ 进生平（按代归类）
let BANNER_T = 0;
function banner(msg, cls) {
  const el = document.getElementById('evBanner');
  if (el) {
    el.innerHTML = msg;
    el.classList.add('on');
    BANNER_T = 3.2;
  }
  log(String(msg).replace(/<[^>]*>/g, ''), cls || 'ok');
}

function log(msg, cls) {
  // ★ Round 24（用户要求）：记录【第几代弟子】，让「录」页能分辨是谁的生平
  //   "这个录记得标出是第几代弟子的记录"
  G.log.unshift({ msg, cls, t: Date.now(), gen: SECT.generation });
  if (G.log.length > 60) G.log.pop();
}


// ★ 安全去重赋值（Round 32）：
//   ⚠️ 测试桩的 createElement() 可能返回一个【不能挂属性的普通对象】
//      ⇒ 直接 el._lastH 会 TypeError。这个 helper 保证两种情况都能工作。
function setDedup(el, html) {
  if (!el) return false;
  try {
    if (el._lastH === html) return false;
    el._lastH = html;
  } catch (e) { /* 不能挂属性 ⇒ 忽略去重 */ }
  el.innerHTML = html;
  return true;
}
function render() {
  const st = playerStats();
  // ★ 事件横幅（域外天魔入侵中）
  {
    const eb = document.getElementById('eventBar');
    if (eb) {
      if (invadeActive()) {
        eb.style.display = 'flex';
        eb.innerHTML = '<b>域外天魔入侵</b>' +
          '<span class="left">' + (EVENT.active ? EVENT.active.place : '未知之地') +
          ' · 余 ' + EVENT.invadeLeft.toFixed(0) + ' 年</span>';
      } else {
        eb.style.display = 'none';
      }
    }
  }

  // ★ 世代 / 宗门 / 场景标签（极简竖窗新元素）
  {
    const gl = document.getElementById('genLabel');
    if (gl) gl.innerHTML = '第 <b>' + SECT.generation + '</b> 代 · <b>' + P.REALMS[realm()] + '</b>';
    const sl = document.getElementById('sceneLabel');
    if (sl) {
      const place = invadeActive() ? (EVENT.active ? EVENT.active.place : '域外') : zbNow().name;
      sl.innerHTML = G.running
        ? ('秘境 · <b>' + place + '</b> · 已入 ' + G.t.toFixed(0) + ' 息')
        : ('秘境 · <b>待入</b>');
      // ★ Round 38：场景背景按【当前秘境五行】切换（assets/秘境/秘境_<五行>.webp）
      //   五行交汇（wx=null）用原水墨背景兜底。
      //   只在秘境变化时写 DOM（同 heroImg 的做法：避免每帧改 src）
      const sceneImg = (typeof document.querySelector === 'function')
        ? document.querySelector('.scene > img') : null;
      if (sceneImg && 'src' in sceneImg) {
        const zw = invadeActive() ? null : zbNow().wx;
        const key = zw ? ('秘境_' + zw) : '__base';
        if (SCENE_BG_KEY !== key) {
          SCENE_BG_KEY = key;
          if (zw) {
            sceneImg.src = 'assets/秘境/秘境_' + zw + '.webp';
            sceneImg.srcset = 'assets/秘境/秘境_' + zw + '@2x.webp 2x';
          } else {
            sceneImg.src = 'assets/asian-mountain-forest-bg__sprite_northWindShrineBG.webp';
            sceneImg.srcset = '';
          }
        }
      }
    }
    // ★ 主角立绘 = 当前【前线弟子】的形象（本来就是弟子在历练，不是抽象主角）
    //   形象编号与名册用同一套散列 ⇒ 名册里"前线 凌霄"和场景里站着的必定是同一个人。
    //   ⚠️ 只在编号变化时才写 DOM（避免每帧改 src，也避开测试桩没有 getAttribute 的问题）
    const heroImg = document.getElementById('heroImg');
    if (heroImg) {
      const hf = ROSTER.front;
      if (hf && hf.alive) {
        const n = 1 + ((hf.id || 0) % AV_COUNT);
        if (HERO_AV !== n) {
          HERO_AV = n;
          heroImg.src = 'assets/弟子/弟子_' + n + '@2x.webp';
        }
        if (heroImg.style) heroImg.style.display = '';
      } else {
        if (heroImg.style) heroImg.style.display = 'none';   // 前线空缺 ⇒ 不显示立绘
      }
    }
    const sn = document.getElementById('sectName');
    if (sn) sn.textContent = SECT_RANKS[SECT.rank].n;
    const sn2 = document.getElementById('sectName2');
    if (sn2) sn2.textContent = SECT_RANKS[SECT.rank].n;
    // ★ 宗门全景横幅：宗门名 + 右上角状态（和「境」的 sceneLabel 同一套渲染时机）
    const bn = document.getElementById('bannerSectName');
    if (bn) bn.textContent = SECT_RANKS[SECT.rank].n;
    const bs = document.getElementById('bannerStat');
    if (bs) {
      const aliveN = ROSTER.list.filter(v => v.alive).length;
      bs.innerHTML = '第 <b>' + SECT.generation + '</b> 代 · <b>' +
        P.REALMS[realm()] + '</b><br>弟子 <b>' + aliveN + '</b> · 荣誉 <b>' +
        Math.round(SECT.honor || 0) + '</b>';
    }
    // ★ Round 41：这个标题原来是【荣誉】—— 但荣誉在地图下方那行已经显示一次了
    //   ⇒ 重复。改成"共 N 件"（传承池件数），荣誉只在宗页顶部显示一处
    const ht = document.getElementById('honorTxt');
    if (ht) ht.textContent = SECT.legacyPool.length;
    // ★★ Round 42：常驻状态栏（宗页顶部）
    const _set = function (id, v) { const el = document.getElementById(id); if (el) el.textContent = v; };
    _set('zbGen', SECT.generation);
    _set('zbDisc', ROSTER.list.filter(function (v) { return v.alive; }).length);
    _set('zbHonor', Math.round(SECT.honor || 0));
    _set('zbMat', Math.round(SECT_RES.materials || 0));
    // 宗门现状卡右上角：距下一阶还差多少
    const _zg = document.getElementById('zongGap');
    if (_zg) {
      const _nx = SECT_RANKS[SECT.rank + 1];
      _zg.textContent = _nx
        ? ('距 ' + _nx.n + ' 还差 ' + Math.max(0, _nx.need - SECT.honor) + ' 荣誉')
        : '已至顶阶';
      _zg.className = 'sub';
    }
  }

  // ★ 顶部：极简竖窗风格（.stat 纵列，无方框）
  {
    const lifeWarn = DISCIPLE.lifespanLeft < 1800;
    // ★★ Round 49：HUD 顶部加【弟子身份行】
    //   用户："境页面这里显示的和当前弟子里面不是一样的吗，那把当前弟子这个模块删除了把"
    //   ⇒ 弟子面板里【面板独有】的东西（头像/名字/灵根缩写/天赋）并进 HUD，
    //     然后删掉弟子面板
    const _fd = ROSTER.front;
    const _fdAv = _fd ? (1 + ((_fd.id || 0) % AV_COUNT)) : 2;
    const _fdLg = _fd ? (AV_LG_SHORT[_fd.linggen] || (_fd.linggen ? '灵' : '—')) : '—';
    const _fdDot = _fd ? (WX_COLOR[WUXING[(_fd.id || 0) % WUXING.length]] || '#888') : '#888';
    $('#hud').innerHTML =
      '<div class="hud-disc">' +
        // 🐞 R61 修：这里原来拼的是 `.png` / `@2x.png`，而 assets/弟子/ 里全是 **.webp**
        //   ⇒ HUD 上的弟子头像一直是浏览器的"破图"占位
        '<span class="av"><img src="assets/弟子/弟子_' + _fdAv + '.webp" ' +
          'srcset="assets/弟子/弟子_' + _fdAv + '@2x.webp 2x" alt="" draggable="false"></span>' +
        '<span class="nm">' + (_fd ? _fd.name : '（无人历练）') + '</span>' +
        '<span class="lg" title="' + (_fd ? (_fd.linggenName || '') : '') + '">' +
          '<i style="background:' + _fdDot + '"></i>' + _fdLg + '</span>' +
        '<span class="tal">' + (_fd ? (_fd.talentName || '') : '') + '</span>' +
      '</div>' +
      '<div class="stat"><span class="k">境界</span><span class="v">' + P.REALMS[realm()] +
        '<small>' + (G.tier + 1) + ' / ' + P.TIERS + ' 档</small></span></div>' +
      '<div class="stat"><span class="k">秘境</span><span class="v">' + zbNow().name +
        '<small>' + (zbNow().wx
          ? ico('wx', zbNow().wx, 'ico12') + zbNow().wx + '属性怪 ' + Math.round(zbNow().bias * 100) + '%'
          : '五行均布') +
        '</small></span></div>' +
      '<div class="stat"><span class="k">灵根</span><span class="v" style="color:' +
        (WX_COLOR[lgOf().els[0]] || '#888') + '">' + lgLabel() +
        '<small>' + lgOf().desc + '</small></span></div>' +
      '<div class="stat"><span class="k">五行</span><span class="v" style="color:' +
        (WX_COLOR[st.wuxing] || '#888') + '">' +
        ico('wx', st.wuxing, 'ico14') + (st.wuxing || '—') +
        '<small>' + ico('wp', WEAPON_ICON[st.weapon.id], 'ico14') + st.weapon.name +
        ' · 范围' + (st.reach * 200).toFixed(0) + ' · 打' + st.aoe + '</small></span></div>' +
      '<div class="stat"><span class="k">气血</span><span class="v' + (G.hp / st.hpMax < 0.35 ? ' low' : '') + '">' +
        Math.max(0, Math.round(G.hp)) + ' / ' + Math.round(st.hp) +
        '<small>闪避 ' + (st.evade * 100).toFixed(0) + '% · 暴击 ' +
          (st.crit * 100).toFixed(0) + '% · 阈值 ' + st.thresh + '</small></span></div>' +
      // ★ Round 49：本局进度（原来只在弟子面板里）
      '<div class="stat"><span class="k">本局</span><span class="v">' +
        G.t.toFixed(0) + ' / ' + P.RUN_SECONDS + ' 息' +
        '<small>击杀 ' + G.kills + ' · 场上 ' + G.field.length +
        (G.spawned >= G.budget ? ' · 预算已尽' : '') + '</small></span></div>' +
      '<div class="stat"><span class="k">杀伐</span><span class="v">' + st.atk.toFixed(0) +
        '<small>出手 ' + st.actFreq.toFixed(1) + '/s</small></span></div>' +
      '<div class="stat"><span class="k">护体</span><span class="v">' + st.def.toFixed(0) +
        '<small>减伤 ' + (dmgMul(st.def) * 100).toFixed(0) + '%</small></span></div>' +
      '<div class="stat"><span class="k">本源</span><span class="v gold">' + G.origin +
        '<small>法宝催动 · 未用则散</small></span></div>' +
      '<div class="stat"><span class="k">天赋</span><span class="v">' +
        '<span style="color:#c8b08a">' + talOf().name + '</span>' +
        ((DISCIPLE.traits && DISCIPLE.traits.length) ? '　' + DISCIPLE.traits.map(function (id) {
          const t = TRAIT_BY_ID[id]; if (!t) return '';
          const r = TRAIT_RAR[t.rar] || {};
          return '<span style="color:' + (r.color || '#888') + '" title="' + (t.desc || '') + '">' + t.name + '</span>';
        }).filter(Boolean).join('　') : '') +
        '<small>寿命向 · ' + talOf().desc + ' · 修炼 ×' + talOf().speed.toFixed(2) +
        (Math.abs(traitMul('speed') - 1) > 1e-9 ? ' → ×' + talSpeedMul().toFixed(2) : '') +
        ((talentEnvy() > 0 || jealousyMul() > 1.001)
          ? ' · <b style="color:#e05555">天妒' +
            (talentEnvy() > 0 ? ' 折寿 ' + Math.round(Math.min(0.25, talentEnvy() * 0.02) * 100) + '%' : '') +
            (jealousyMul() > 1.001 ? ' 渡劫×' + jealousyMul().toFixed(2) : '') + '</b>' : '') +
        '</small></span></div>' +
      '<div class="stat"><span class="k">寿元</span><span class="v' + (lifeWarn ? ' low' : '') + '">' +
        fmtLife(DISCIPLE.lifespanLeft) +
        '<small>' + fmtLifeReal(DISCIPLE.lifespanLeft) +
        (DISCIPLE.lifeGain > 0 ? ' · 突破累计 +' + Math.round(DISCIPLE.lifeGain) + ' 年' : '') +
        '</small></span></div>' +
      '<div class="stat"><span class="k">同调</span><span class="v">' + st.td.level + ' 级' +
        '<small>×' + st.td.mul.toFixed(2) + ' · 值 ' + st.td.value + '</small></span></div>';
  }

  // 战斗区
  const prog = Math.min(1, G.t / P.RUN_SECONDS);
  const kills = G.kills;
  $('#battleBar').style.width = (prog * 100) + '%';
  $('#battleInfo').innerHTML = G.running
    ? `<span>${G.t.toFixed(0)}s / ${P.RUN_SECONDS}s</span>
       <span>击杀 <b>${kills}</b></span>
       <span>${st.weapon.name} <span class="dim">范围${(st.reach * 200).toFixed(0)} · 打${st.aoe}</span></span>
       <span>场上 <b>${G.field.length}</b></span>
       <span>掉落 <b>${G.dropped}</b></span>
       <span>超压 <b class="${G.overloadT>0?'low':''}">${G.overloadT.toFixed(1)}s</b></span>`
    : `<span class="dim">${G.phase === 'rest' ? '结算中…' : '待命'}</span>`;

  // ★ 修为条（灵气进度）
  {
    const need = qiNeed(G.tier);
    const pct = G.tier >= P.TIERS - 1 ? 100 : Math.min(100, G.qi / need * 100);
    const rEl = document.getElementById('qiRealm');
    const bEl = document.getElementById('qiBar');
    const tEl = document.getElementById('qiTxt');
    const sub = document.getElementById('qiTierTxt');
    if (rEl) rEl.textContent = P.REALMS[realm()];
    if (sub) sub.textContent = '(' + (G.tier % P.REALM_PER_TIER + 1) + '/' + P.REALM_PER_TIER + ' 层)';
    if (bEl) bEl.style.width = pct + '%';
    if (tEl) tEl.textContent = G.tier >= P.TIERS - 1
      ? '已至圆满'
      : Math.floor(G.qi) + ' / ' + need + ' 灵气';
  }

  // ★ 威胁圈 / 攻击范围：只画出来，不标数字（用户要求：让玩家靠画面感受）
  const bw = $('#battleWrap');
  if (bw) {
    const W = bw.clientWidth || 480;
    const reachPx = st.reach * W * 2;
    // ★ 威胁圈【完全不可见】——玩家只能看到怪变多，自己感受危险
    //   （用户决策：不需要告诉玩家威胁圈在哪、有多大）
    const rr = $('#reachRing');
    if (rr) { rr.style.width = reachPx + 'px'; rr.style.height = (reachPx * 0.80) + 'px'; }
  }

  // ★ 挂机报告：有重要事件时显示
  {
    const rp = document.getElementById('reportPanel');
    const rb = document.getElementById('reportBody');
    if (rp && rb) {
      // ★ Round 35：改用编年史渲染（双区 + 带时刻 + 强度跃升）
      const _reportHtml = renderIdleReport(G._seenAt);
      const hasContent = _reportHtml.indexOf('cr-empty') < 0;
      // ★ 三条门槛，避免"开局就弹"或"每帧闪"：
      //   ① 有重要内容  ② 距上次查看超过 30 秒  ③ 距上次弹面板超过 60 秒
      const awayMs = Date.now() - (G._seenAt || 0);
      // ★ 有离线结算时立刻显示（这是玩家最需要看到的）
      const shouldShow = (G._offline && !G._offlineShown) ||
        (hasContent && awayMs > 30000 && (Date.now() - (G._lastReportShow || 0) > 60000));
      if (shouldShow) {
        const ttl = document.querySelector('.rp-hd b');
        if (ttl) ttl.textContent = (G._offline && !G._offlineShown) ? '你离开的时候' : '你不在的时候';
        rb.innerHTML = _reportHtml;
        rp.style.display = 'block';
        G._lastReportShow = Date.now();
      }
    }
  }

  // ★ 玩家角色：跟着游走位置移动 + 血条 + 受击抖动 + 闪避闪光
  const heroHp = document.getElementById('heroHp');
  if (heroHp) heroHp.style.width = Math.max(0, G.hp / st.hp * 100) + '%';
  const hero = document.getElementById('hero');
  if (hero) {
    hero.style.left = (G.heroX * 100) + '%';
    hero.style.top = (G.heroY * 100) + '%';
    hero.classList.toggle('hurt', G.shake > 0);
    hero.classList.toggle('dodge', G.dodgeFlash > 0);
    // ★ Round 36：出手动画（#hero.attacking）
    //   ⚠️ 不能只用 toggle(..., G.attackT>0)：连续出手时类名一直是 true
    //      ⇒ CSS 动画不会重播。必须【先移除、强制重排、再加回】。
    //   收尾交给 animationend（比定时器可靠，切页签回来也不会卡住动画）
    const wantAtk = G.attackT > 0;
    if (wantAtk && !hero._atk) {
      hero._atk = true;
      hero.classList.remove('attacking');
      void hero.offsetWidth;                 // 强制重排 ⇒ 动画重新开始
      hero.classList.add('attacking');
    } else if (!wantAtk && hero._atk) {
      hero._atk = false;
      hero.classList.remove('attacking');
    }
  }
  // 突破闪光（0.5 秒）
  if (breakoutFlash > 0) {
    breakoutFlash -= 0.08;
    const bw2 = $('#battleWrap');
    if (bw2) bw2.classList.toggle('breaking', breakoutFlash > 0);
    if (breakoutFlash <= 0) { const bw3 = $('#battleWrap'); if (bw3) bw3.classList.remove('breaking'); }
  }
  // 攻击范围跟着角色走（威胁圈已完全隐形，不再绘制）
  const rrM = $('#reachRing');
  if (rrM) { rrM.style.left = (G.heroX * 100) + '%'; rrM.style.top = (G.heroY * 100) + '%'; }

  renderSkillBar();   // ★ R66：弟子脚下的技能进度条（自走棋那种"还差多少才放"）

  // ★★ R62：顿帧（hitstop）—— 只冻【表现】，数值照旧跑
  //   冻游戏时钟会改 DPS 与一局时长 ⇒ 破坏配平，所以 G.freezeUntil 是一段真实时间。
  //   冻结期间：① 不写 mob 的 left/top（位置不跳变）② #battleWrap 挂 .freeze 暂停关键帧动画
  const _frozen = Date.now() < (G.freezeUntil || 0);
  {
    const wrap = document.getElementById('battleWrap');
    if (wrap && wrap.classList) wrap.classList.toggle('freeze', _frozen);
  }
  // ★ 敌人：复用 DOM 元素（这样 CSS transition 才能做出"移动"效果）
  const arena = $('#arena');
  if (!arena._mobs) arena._mobs = {};
  const mobs = arena._mobs;
  const seen = new Set();
  for (const e of G.field.slice(0, 36)) {
    if (!e._id) e._id = 'm' + (UID++);
    seen.add(e._id);
    let el = mobs[e._id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'mob' + (e.kind === 'elite' ? ' elite' : '') + (e.kind === 'boss' ? ' boss' : '');
    // ★ Boss 头顶挂名字（复用 AOE 系统，只是加个标签）
    if (e.kind === 'boss' && e.name) {
      const bt = document.createElement('span');
      bt.className = 'bossTag';
      bt.textContent = '★ ' + e.name;
      el.appendChild(bt);
    }
      el.innerHTML = '<div class="hpbar"><i></i></div>';
      arena.appendChild(el);
      mobs[e._id] = el;
    }
    if (!_frozen) {                       // ★ R62：顿帧期间不写坐标 ⇒ 位置停住、解冻后不跳变
      el.style.left = (e.x * 100) + '%';
      el.style.top = (e.y * 100) + '%';
    }
    el.style.opacity = 0.5 + 0.5 * Math.max(0, e.hp / e.maxHp);
    el.classList.toggle('hit', e.hit > 0);
    el.classList.toggle('lunge', Date.now() < (e._lungeUntil || 0));   // ★ R210：扑击
    // ★ 妖怪贴图（Round 38）：有图的用图，没图的（域外天魔）退回五行色块
    //   贴图挂 .sprite（::before 会挡住 hpbar，所以用真实子元素更好控制层级）
    //   Round 39：Boss 走独立映射表 BOSS_SPRITE（文件名不带 _Boss 后缀）
    const isBossKind = (e.kind === 'boss');
    const spName = isBossKind ? null : MOB_SPRITE[e.mk];
    const bossFile = isBossKind ? BOSS_SPRITE[e.mk] : null;
    if (spName || bossFile) {
      let sp = el._sp;
      if (!sp) {
        sp = document.createElement('div');
        sp.className = 'sprite';
        // ⚠️ 用 appendChild 而不是 insertBefore —— .sprite 是绝对定位，
        //    放在子元素最后不影响布局；而测试桩的 DOM 没实现 insertBefore。
        el.appendChild(sp);
        el._sp = sp;
      }
      // ★ Round 41：精英【复用同一张图】（只靠 CSS 放大 + 金环/金辉/菱形区分）
      //   ⇒ 不再有 _精英 后缀贴图
      const url = bossFile
        ? 'url(assets/妖怪/' + bossFile + '.webp)'
        : 'url(assets/妖怪/妖_' + spName + '.webp)';
      if (el._spUrl !== url) {
        el._spUrl = url;
        sp.style.backgroundImage = url;
      }
      if (el._noSprite) { el.classList.remove('nosprite'); el._noSprite = false; }
    } else {
      // 无贴图 ⇒ 用五行色块兜底
      if (!el._noSprite) { el.classList.add('nosprite'); el._noSprite = true; }
      if (e.wx) {
        const c = WX_COLOR[e.wx] || '#888';
        el.style.borderColor = c;
        el.style.background = 'radial-gradient(circle at 35% 30%, ' + c + 'cc, ' + c + '55)';
      }
    }
    const bar = el.querySelector('.hpbar i');
    if (bar) bar.style.width = Math.max(0, e.hp / e.maxHp * 100) + '%';
  }
  // 清理已死/离场的
  // ★★ R61：不立即删 —— 先打 .dying 让怪【碎裂消散】，VFX.DIE_MS 之后才真正移除。
  //   这是"看不出砍死怪物"最关键的一处：原来怪是"凭空消失"的，玩家只看到数量少了。
  //   注意：行为层完全没改（怪在 field 里已经被删掉了，这里拖的只是 DOM 的存在时间）。
  for (const id of Object.keys(mobs)) {
    if (seen.has(id)) continue;
    const el = mobs[id];
    if (!el._dying) {
      el._dying = Date.now();
      if (el.classList && el.classList.add) el.classList.add('dying');
    }
    if (Date.now() - el._dying >= VFX.DIE_MS) {          // ★ R63：真实毫秒
      el.remove ? el.remove() : arena.removeChild && arena.removeChild(el);
      delete mobs[id];
    }
  }

  // ★★ R61：近战弧光 / 远程弹道
  //   坐标与怪物同一套（`x*100%`）· 全部走 CSS 动画，不占 JS 主循环
  // ★ R62：顿帧期间不渲染新特效（否则"生出来就冻住"，解冻才动，看着像卡帧）
  if (!_frozen) vfxRender(arena);

  // ★ 飘字
  if (!arena._fx) arena._fx = {};
  const fxBox = arena._fx;
  const now = Date.now();
  for (const f of G.fx) {
    if (!f._id) f._id = 'f' + (UID++);
    let el = fxBox[f._id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'pop ' + (f.cls || 'dmg');
      // ★ 克制特效：数字用【玩家五行】的颜色
      if (f.wx && WX_COLOR[f.wx]) el.style.color = WX_COLOR[f.wx];
      el.textContent = f.txt;
      el.style.left = (f.x * 100) + '%';
      el.style.top = (f.y * 100) + '%';
      el._birth = now;
      // 动画结束就删（不依赖每帧扫描）
      el.addEventListener('animationend', () => {
        if (el.parentNode === arena) arena.removeChild(el);
        delete fxBox[f._id];
      });
      arena.appendChild(el);
      fxBox[f._id] = el;
    }
  }
  // 兜底：清掉超龄或已不在 G.fx 里的飘字（防泄漏）
  for (const id of Object.keys(fxBox)) {
    const el = fxBox[id];
    if (now - (el._birth || 0) > 900) {
      if (el.parentNode === arena) arena.removeChild(el);
      delete fxBox[id];
    }
  }

  // 分区网格
  for (const z of Object.keys(G.zones)) {
    const el = document.getElementById('zone-' + z);
    if (!el) continue;
    const zc = G.zones[z];
    // ★ 不用 querySelector：因为下面会清空 el，子元素会被销毁
    //   改为持有子元素引用（el._hd / el._grid）
    const hd = el._hd, grid = el._grid;
    if (!hd || !grid) continue;
    let used = 0;
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (c && c._anchor) used += c.cells;
    }
    hd.innerHTML =
      `<b>${z}</b><em class="${used >= zoneCap(z) ? 'full' : ''}">${used}/${zoneCap(z)}</em>`;
    grid.innerHTML = '';
    // 格子尺寸由 CSS 定（.zg .cell 是 14px），这里只给列数
    grid.style.gridTemplateColumns = `repeat(${zc.w}, 14px)`;
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (c && c._anchor) {
        cell.classList.add('item');
        cell.style.background = QCOLOR[c.q] + '33';
        cell.style.borderColor = QCOLOR[c.q];
        const [w, h] = c.shape;
        if (w > 1) cell.style.gridColumn = `span ${w}`;
        if (h > 1) cell.style.gridRow = `span ${h}`;
        cell.innerHTML = `<span>${c.slot}</span>`;
        cell.title = `${QUALITIES[c.q]}${c.slot}  ${c.kind} +${c.mainVal}  (${w}×${h})`;
        cell.draggable = true;
        cell.dataset.zone = z; cell.dataset.x = x; cell.dataset.y = y;
        cell.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text', JSON.stringify({ from: 'zone', zone: z, x, y })); });
      } else if (c && c._part) {
        cell.style.visibility = 'hidden';
      } else {
        // 空格：用虚线边框区分"可放"的位置（原网格版所有格子一样，看不出空隙）
        cell.classList.add('empty');
      }
      cell.dataset.gx = x; cell.dataset.gy = y;
      // ★ 右键 = 卸下该件装备（放回背包）
      cell.addEventListener("contextmenu", ev => {
        ev.preventDefault();
        const cc = G.zones[z].cells[y][x];
        if (!cc) return;
        if (cc._anchor) unequipAt(z, x, y);
        else if (cc._part && cc.ref) unequipAt(z, cc.ref._px, cc.ref._py);
      });
      cell.addEventListener('dragover', ev => ev.preventDefault());
      cell.addEventListener('drop', ev => {
        ev.preventDefault();
        const d = JSON.parse(ev.dataTransfer.getData('text'));
        const it = d.from === 'bag' ? G.bag[d.idx] : removeFromZone(d.zone, d.x, d.y);
        if (!it) return;
        if (canPlace(it, z, x, y)) {
          place(it, z, x, y);
          if (d.from === 'bag') G.bag.splice(d.idx, 1);
        } else {
          if (d.from === 'zone') place(it, d.zone, d.x, d.y);   // 放回
          log('放不下：' + z + ' 容量或空间不足', 'warn');
        }
        render();
      });
      grid.appendChild(cell);
    }
  }

  // ★ 背包（带"值得一看"标记 + 排序 + 过滤）
  const bag = $('#bagList');
  // ★ 先把"非装备"条目（功法书 / 法宝）挑出来单独渲染
  //   它们没有 slot/shape/affix，不能走装备那条路（会崩）
  let specList = G.bag.map((it, i) => ({ it, i }))
    .filter(x => x.it.kind2 === 'gongfa' || x.it.kind2 === 'fabao');
  // 排序
  let list = G.bag.map((it, i) => ({ it, i })).filter(x => !x.it.kind2);
  if (G.sortsBy === 'q') list.sort((a, b) => b.it.q - a.it.q || (b.it._gain || 0) - (a.it._gain || 0));
  else if (G.sortsBy === 'slot') list.sort((a, b) => a.it.slot.localeCompare(b.it.slot, 'zh'));
  else list.sort((a, b) => (b.it._gain || 0) - (a.it._gain || 0));
  // 过滤：只看有提升的
  if (G.onlyUpgrade) list = list.filter(x => (x.it._gain || 0) > 0.005);
  bag.innerHTML = '';
  if (list.length === 0) {
    bag.innerHTML = '<div class="dim" style="padding:8px">' +
      (G.bag.length === 0 ? '（空）' : '（当前筛选下没有更好的装备）') + '</div>';
  }
  // ★ 功法书 / 法宝的卡片（点击即获得并装上）
  specList.forEach(({ it, i }) => {
    const d = document.createElement('div');
    const isGf = it.kind2 === 'gongfa';
    const learned = isGf && GF_KNOWN[it.gfId];
    const owned = !isGf && FB_OWNED[it.fbId];
    d.className = 'bag-i spec' + (isGf ? ' gf' : ' fb');
    d.style.borderLeftColor = isGf ? '#6ea8fe' : '#c9a227';
    d.title = (isGf ? '功法书' : '法宝') + '\n左键：获得并装上\n右键：丢弃';
    d.innerHTML = '<span class="q" style="color:' + (isGf ? '#6ea8fe' : '#c9a227') + '">' +
      (isGf ? it.type : it.wx) + '</span>' +
      '<span class="nm"><b>' + it.name + '</b></span>' +
      '<span class="dim spec-desc">' + (it.desc || '').replace(/\n/g, ' ') + '</span>' +
      (learned || owned ? '<span class="same">已有</span>' : '<span class="up">NEW</span>');
    d.addEventListener('click', () => {
      if (isGf) { grantGongfa(it.gfId); log('学会并装上功法·' + GF_BY_ID[it.gfId].name, 'ok'); }
      else { grantFabao(it.fbId); log('获得并装上法宝·' + FABAO_BY_ID[it.fbId].name, 'ok'); }
      G.bag.splice(G.bag.indexOf(it), 1);
      render();
    });
    d.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      G.bag.splice(G.bag.indexOf(it), 1);
      log('丢弃 ' + it.name, 'sys'); render();
    });
    bag.appendChild(d);
  });
  list.slice(0, 50).forEach(({ it, i }) => {
    const d = document.createElement('div');
    const g = it._gain || 0;
    // 只标差异，不给结论：用箭头 + 百分比，不出现"建议装备"字样
    const tag = g > 0.02 ? `<span class="up">▲${(g * 100).toFixed(0)}%</span>`
      : g < -0.02 ? `<span class="down">▼${(-g * 100).toFixed(0)}%</span>`
      : `<span class="same">＝</span>`;
    d.className = 'bag-i' + (g > 0.02 ? ' good' : '');
    d.draggable = true;
    d.style.borderLeftColor = QCOLOR[it.q];
    d.title = '点击：自动找最优位置穿上\n右键：分解为素材';
    d.innerHTML = `<span class="q" style="color:${QCOLOR[it.q]}">${QUALITIES[it.q]}</span>
      <span class="nm"><b>${itemName(it)}</b> <span class="dim">${it.kind}+${it.mainVal}</span></span>
      <span class="wx" style="color:${WX_COLOR[it.wx]||'#888'}">${it.wx||''}</span>
      <span class="af dim" title="${affixTitle(it)}">${affixLabel(it)}</span>
      <span class="sg" title="${sigTitle(it)}">${sigLabel(it)}</span>
      <span class="sz dim">${it.shape[0]}×${it.shape[1]}</span>${tag}`;
    d.addEventListener('dragstart', ev => ev.dataTransfer.setData('text', JSON.stringify({ from: 'bag', idx: i })));
    d.addEventListener('click', () => { G.compare = it; bestEquip(i); });
    d.addEventListener('contextmenu', ev => { ev.preventDefault(); scrapAt(i); });
    d.addEventListener('mouseenter', () => { G.compare = it; renderCompare(); });
    bag.appendChild(d);
  });
  renderCompare();

  // ★ 传承面板
  {
    const lb = document.getElementById('legacyBox');
    if (lb) {
      const rows = [];
      rows.push('<div class="lc"><span class="dim">传承池</span><b>' +
        SECT.legacyPool.length + '</b> 件</div>');
      if (SEARCH.active) {
        rows.push('<div class="lc"><span class="dim">搜寻中</span><b class="gold">剩余 ' +
          SEARCH.left + ' 局</b></div>');
      } else if (SEARCH.found > 0) {
        rows.push('<div class="lc"><span class="dim">上次搜寻</span><b class="ok">取回 ' +
          SEARCH.found + ' 件</b></div>');
      }
      if (SECT.lostLegacy.length > 0) {
        rows.push('<div class="lc"><span class="dim">遗落在外</span><b class="bad">' +
          SECT.lostLegacy.length + ' 件</b>' +
          '<div class="hint">弟子会自动搜寻；修为越接近遗落深度，取回越多</div></div>');
      } else {
        rows.push('<div class="lc"><span class="dim">遗落在外</span><b>无</b></div>');
      }
      rows.push('<div class="lc"><span class="dim">历代弟子</span><b>' +
        SECT.history.length + '</b> 代</div>');
      // ★ 传承给赠（含余韵倒计时与阶段）
      const gs = giftStatus();
      if (gs.length) {
        rows.push('<div style="margin-top:6px;color:#66708a;font-size:10px">传承给赠</div>');
        for (const g of gs) {
          const t = g.left < 0 ? '永久' : (g.left >= 3600
            ? Math.floor(g.left / 3600) + '时' + Math.floor(g.left % 3600 / 60) + '分'
            : Math.floor(g.left / 60) + '分' + Math.floor(g.left % 60) + '秒');
          rows.push('<div class="gf' + (g.phase === 2 ? ' wane' : '') + '">' +
            '<span>' + g.name + (g.layers > 1 ? ' ×' + g.layers : '') + '</span>' +
            '<b>' + Math.round(g.power * 100) + '% · ' + t + '</b></div>');
        }
      }
      lb.innerHTML = rows.join('');
      // ★ 功法五槽（每类一个下拉，互斥）
      //
      //   ★★ Round 24 结构性修法（这是最终方案）：
      //     gb 容器【只放三个稳定子容器】，谁都不重建谁：
      //       .gf-main  ← 五个下拉（会随"学会的功法"变化而更新）
      //       .gf-prio-box ← 优先级排序
      //       .gf-cd-box   ← 冷却状态
      //     每个子容器【各自做内容去重】⇒ 内容没变就完全不碰 DOM
      //     ⇒ ① 不再有 appendChild 累积（子容器只建一次）
      //       ② 展开的下拉不受影响（下拉所在元素始终是同一个）
      const gb = document.getElementById('gongfaBox');
      if (gb) {
        // ⚠️ 不要用 querySelector 判断"是否已建" —— 测试桩的 querySelector 可能
        //    永远返回非 null（_smoke.js 的桩就是）⇒ 子容器会变成【游离节点】，
        //    appendChild 永不执行 ⇒ 界面上看不到。用显式标志最可靠。
        if (!gb._built) {
          // ⚠️ 先建好、再标记 _built（否则中途抛错会留下半初始化状态）
          const _m = document.createElement('div'); _m.className = 'gf-main';
          const _p = document.createElement('div'); _p.className = 'gf-prio-box';
          const _c = document.createElement('div'); _c.className = 'gf-cd-box';
          if (typeof gb.replaceChildren === 'function') gb.replaceChildren();
          else gb.innerHTML = '';
          gb.appendChild(_m); gb.appendChild(_p); gb.appendChild(_c);
          gb._main = _m; gb._prioBox = _p; gb._cdBox = _c; gb._built = true;
        }
        const _main = gb._main, _prioBox = gb._prioBox, _cdBox = gb._cdBox;
        const html = GF_TYPES.map(t => {
          // ★ 只列出【已学会】的功法（未学会的靠掉落）
          const opts = GONGFA.filter(g => g.type === t && GF_KNOWN[g.id])
            .map(g => '<option value="' + g.id + '"' +
              (GF.eq[t] === g.id ? ' selected' : '') + '>' + g.name + '</option>').join('');
          const _lk = (GF.gfLock && GF.gfLock[t]) ? ' 🔒' : '';
          // ★ R66：这一行的进度条 = 该类型【已装功法】的冷却进度（与 gfReady 同源）
          const _eqg = GF_BY_ID[GF.eq[t]];
          const _pg = _eqg ? gfProgress(_eqg) : null;
          const _pgTxt = _eqg && _pg !== null
            ? '（还差 ' + Math.max(0, Math.round((1 - _pg) * (_eqg.cd === 'swing' ? _eqg.cdN : _eqg.cdN))) +
              (_eqg.cd === 'swing' ? ' 加权出手' : _eqg.cd === 'sec' ? ' 秒' : '') + '）'
            : '';
          return '<div class="gf-row"><span class="tp">' + ico('gf', t, 'ico16') + t + _lk + '</span>' +
            '<select data-gftype="' + t + '"><option value="">（空）</option>' + opts + '</select>' +
            (_pg === null ? ''
              : '<i class="pg' + (_pg >= 1 ? ' rdy' : '') + '" title="' + _eqg.name + ' ' + _pgTxt +
                '"><b style="width:' + (_pg * 100).toFixed(1) + '%;background:' +
                (GF_TYPE_COLOR[t] || '#c8b08a') + '"></b></i>') +
            '</div>';
        }).join('');
        const stacks = [];
        if (GF.killStack > 0) stacks.push('焚心 ' + Math.min(GF.killStack, 50) + ' 层');
        if (GF.speedStack > 0) stacks.push('追风 ' + Math.min(GF.speedStack, 6) + ' 层');
        if (gfOn('m_hunli')) stacks.push('魂力 ' + GF.soul + '/100');
        const _mh = html + (stacks.length
          ? '<div class="gf-stack">' + stacks.join(' · ') + '</div>' : '');
        // ★ 各自去重：内容没变 ⇒ 完全不碰 DOM（展开的下拉因此不会被刷掉）
        if (setDedup(_main, _mh)) {
          // 切换下拉的事件（新元素才绑）
          _main.querySelectorAll('select[data-gftype]').forEach(sel => {
            if (sel._bound) return; sel._bound = true;
            sel.addEventListener('change', ev => {
              const ty = sel.getAttribute('data-gftype');
              const v = ev.target.value;
              GF.gfLock = GF.gfLock || {};
              if (v) { gfEquip(v, true); GF.gfLock[ty] = true; }   // ★ 手动 ⇒ 打锁
              else { delete GF.eq[ty]; GF.gfLock[ty] = true; }      // 手动清空也锁（尊重玩家）
              autoPickGongfa();
              render();
            });
          });
        }
        // ★ 主动技能的【优先级排序】（玩家预设"谁先放" —— 这是挂机游戏的能动性）
        const pr = gfPriority();
        if (pr.length > 1) {
          _prioBox.className = 'gf-prio-box gf-row';
          _prioBox.style.marginTop = '4px';
          const _ph = '<span class="tp">优先</span>' +
            pr.map((id, i) => {
              const g = GF_BY_ID[id];
              return '<span class="prio" data-prio="' + id + '">' + (i + 1) + '.' + g.name +
                '<b class="up" data-dir="-1">▲</b><b class="dn" data-dir="1">▼</b></span>';
            }).join('');
          if (setDedup(_prioBox, _ph)) {
            _prioBox.querySelectorAll('[data-dir]').forEach(el => {
              el.addEventListener('click', ev => {
                ev.stopPropagation();
                const id = el.parentNode.getAttribute('data-prio');
                gfMovePrio(id, parseInt(el.getAttribute('data-dir'), 10));
                render();
              });
            });
          }
        } else {
          _prioBox.className = 'gf-prio-box';
          setDedup(_prioBox, '');
        }
        // ★ 主动技能的冷却状态（让玩家看到"下一个要放哪个"）
        //   ★ Round 24：改为写入稳定的 _cdBox（不再每帧 appendChild）
        if (pr.length) {
          const _cdh = pr.map(id => {
            const g = GF_BY_ID[id];
            const used = GF.fired[id] || 0;
            let state;
            if (g.cd === 'run') state = GF.usedRun[id] ? '已用' : '就绪';
            else if (g.cd === 'swing') {
              const left = Math.max(0, g.cdN - (GF.swings - GF.lastSwing[id]));
              state = left > 0 ? (left + ' 刀') : '就绪';
            } else {
              const left = Math.max(0, g.cdN - ((G.t || 0) - GF.lastSec[id]));
              state = left > 0.1 ? (left.toFixed(1) + 's') : '就绪';
            }
            return g.name + '(' + state + '×' + used + ')';
          }).join(' · ');
          if (setDedup(_cdBox, _cdh)) {
            _cdBox.className = 'gf-cd-box gf-stack';
            _cdBox.style.color = '#66708a';
          }
        } else { setDedup(_cdBox, ''); }
      }
      // ★ 锻造部 / 训话 / 门装模板（Round 18）
      {
        const sm = document.getElementById('sectMat');
        if (sm) sm.textContent = SECT_RES.materials;
        // 锻造部
        const fb = document.getElementById('forgeBox');
        if (fb) {
          let html3 = '<div class="fg-row" style="border-top:none">' +
            '<span class="ct">累计锻造 ' + SECT_RES.forged + ' 件 · 耗素材 ' + SECT_RES.spent + '</span>' +
            '<button data-forge-all="1">一次造齐</button></div>';
          for (const r of FORGE_RECIPES) {
            const cost = forgeCost(r);
            const can = SECT_RES.materials >= cost;
            const owned = G.bag.filter(x => x._forged && x.slot === r.slot).length;
            html3 += '<div class="fg-row"><span class="nm">' + r.name + '</span>' +
              '<span class="ct">' + QUALITIES[r.q] + (owned ? ' ·已有' + owned : '') + '</span>' +
              '<button data-forge="' + r.slot + '"' + (can ? '' : ' disabled') + '>' + cost + '</button></div>';
          }
          fb.innerHTML = html3;
          fb.querySelectorAll('button[data-forge]').forEach(function (b) {
            if (b._bound) return; b._bound = true;
            b.addEventListener('click', function () {
              const slot = b.getAttribute('data-forge');
              const rec = FORGE_RECIPES.find(x => x.slot === slot);
              if (rec && forge(rec)) render();
            });
          });
          const all = fb.querySelector('button[data-forge-all]');
          if (all && !all._bound) { all._bound = true; all.addEventListener('click', function () { forgeAll(); render(); }); }
        }
        // ★ 弟子名册 + 后勤岗位（Round 22）
        {
          const rs = document.getElementById('rosterStat');
          const rb = document.getElementById('rosterBox');
          const alive = ROSTER.list.filter(x => x.alive);
          if (rs) {
            const f = ROSTER.front;
            rs.textContent = '在册 ' + alive.length + '/' + baseRecruit() +
              (f && f.alive ? ' · 历练 ' + f.name : ' · 无人历练');
          }
          if (rb) {
            let h7 = '';
            // ★ 弟子头像：AI 生成素材（assets/弟子/）
            //   形象 + 圆盘配色按弟子 id 稳定散列选取 ⇒ 同一弟子每次渲染外观不变，
            //   同代弟子之间各不相同。错峰延迟做出"一排人在各自活动"的观感。
            let avIdx = 0;
            for (const x of alive) {
              const rc = x.role === 'front' ? 'front' : (x.role === 'back' ? 'back' : 'idle');
              const post = x.post ? (FAC_BY_ID[x.post] || {}).name : '';
              const avNo = 1 + ((x.id || avIdx) % AV_COUNT);
              // ⚠️ 圆盘索引不能再用 id*3+1：它与 6 不互质 ⇒ 周期只有 2，颜色会重复。
              //    直接用 (id-1) 取模，相邻 id 必然拿到不同颜色。
              const [dc1, dc2] = AV_DISC[((x.id || 0) + AV_DISC.length - 1) % AV_DISC.length];
              const lgShort = AV_LG_SHORT[x.linggen] || (x.linggen ? '灵' : '—');
              const lgDot = WX_COLOR[WUXING[(x.id || 0) % WUXING.length]] || '#888';
              // 错峰：每行延迟不同 + 轻微垂直相位差，避免整齐划一
              const avDelay = (avIdx * 0.23) % 2.2;
              const avShift = (avIdx % 3) * 0.6;
              h7 += '<div class="rs-row has-av" data-rid="' + (x.id || 0) + '" title="点一下看他的数据">' +
                '<span class="av" style="--c1:' + dc1 + ';--c2:' + dc2 +
                  ';margin-top:' + avShift.toFixed(1) + 'px">' +
                '<img src="assets/弟子/弟子_' + avNo + '.webp" ' +
                  'srcset="assets/弟子/弟子_' + avNo + '@2x.webp 2x" ' +
                  'alt="" loading="lazy" draggable="false" ' +
                  'style="animation-delay:-' + avDelay.toFixed(2) + 's"></span>' +
                '<span class="role ' + rc + '">' + ROLES[x.role] + '</span>' +
                '<span class="nm">' + x.name + '</span>' +
                '<span class="lg" title="' + (x.linggenName || '') + '">' +
                  '<i style="background:' + lgDot + '"></i>' + lgShort + '</span>' +
                '<span class="tal">' + x.talentName + '</span>' +
                '<span class="post">' + post + '</span>' +
                '<span class="life">' + Math.round(x.lifespanLeft) + ' 年</span></div>';
              avIdx++;
            }
            if (!alive.length) h7 += '<div class="rs-row" style="color:#5d574c">（尚无弟子）</div>';
            // 后勤产出
            const bl = backlineBonus();
            h7 += '<div style="margin-top:5px;border-top:1px solid var(--line2);padding-top:4px">';
            for (const f of FACILITIES) {
              const n = alive.filter(x => x.post === f.id).length;
              h7 += '<div class="rs-fac"><span class="fn">' + f.name + '</span>' +
                '<span class="fp">' + n + '/' + f.slots + '</span>' +
                '<span class="fo">' + f.desc + '</span></div>';
            }
            h7 += '<div class="rs-fac" style="color:#c9a227"><span class="fn">产出</span>' +
              '<span class="fo">素材+' + bl.mats + ' · 修炼×' + bl.qi.toFixed(3) +
              ' · 掉落×' + bl.drop.toFixed(3) + ' · 续命+' + bl.life + '年</span></div>';
            h7 += '</div>';
            rb.innerHTML = h7;
          }
        }

        // ★ 铸造四层（Round 19）
        const cb = document.getElementById('castBox');
        if (cb) {
          const bagItems = G.bag.filter(x => !x.kind2);
          let h6 = '<div class="cs-hd">铸造 · 重铸' + SECT_RES.reforged +
            ' / 转移' + SECT_RES.transferred + ' / 定向' + SECT_RES.targeted + '</div>';
          // 装备下拉（重铸 / 转移用）
          const optIt = bagItems.map(function (x, i) {
            return '<option value="' + i + '">' + (x.slot || '?') + ' q' + x.q +
              ' [' + (x.affixes || []).join(',') + ']</option>';
          }).join('');
          // ② 重铸
          h6 += '<div class="cs-row"><span class="lb">重铸</span>' +
            '<select data-cast-it="1">' + (optIt || '<option>（背包空）</option>') + '</select>' +
            '<span class="ct">' + (bagItems[0] ? reforgeCost(bagItems[0]) : '-') + '</span>' +
            '<button data-cast-rf="1">重摇</button></div>';
          // ③ 转移（源 + 目标）
          h6 += '<div class="cs-row"><span class="lb">转移</span>' +
            '<select data-cast-src="1">' + (optIt || '<option>-</option>') + '</select>' +
            '<button data-cast-tf="1">搬词缀</button></div>';
          h6 += '<div class="cs-row"><span class="lb">&nbsp;</span>' +
            '<select data-cast-dst="1">' + (optIt || '<option>-</option>') + '</select>' +
            '<span class="ct">同部位 · ' + (bagItems[0] ? transferCost(bagItems[0]) : '-') + '</span></div>';
          // ④ 定向
          const tp = targetPool();
          h6 += '<div class="cs-row"><span class="lb">定向</span>' +
            '<select data-cast-want="1">' +
            tp.map(function (a) { return '<option value="' + a.id + '">' + a.name + '（' + a.desc.replace(/X/g, 'N') + '）</option>'; }).join('') +
            '</select></div>';
          h6 += '<div class="cs-row"><span class="lb">&nbsp;</span>' +
            '<select data-cast-slot="1">' +
            Object.keys(SECT_DOCTRINE.want).map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') +
            '</select><button data-cast-tg="1">定向铸造</button></div>';
          cb.innerHTML = h6;
          // 事件
          const rfBtn = cb.querySelector('button[data-cast-rf]');
          if (rfBtn && !rfBtn._bound) {
            rfBtn._bound = true;
            rfBtn.addEventListener('click', function () {
              const i = parseInt(cb.querySelector('select[data-cast-it]').value, 10);
              const arr = G.bag.filter(x => !x.kind2);
              if (arr[i] && reforge(arr[i])) render();
            });
          }
          const tfBtn = cb.querySelector('button[data-cast-tf]');
          if (tfBtn && !tfBtn._bound) {
            tfBtn._bound = true;
            tfBtn.addEventListener('click', function () {
              const arr = G.bag.filter(x => !x.kind2);
              const si = parseInt(cb.querySelector('select[data-cast-src]').value, 10);
              const di = parseInt(cb.querySelector('select[data-cast-dst]').value, 10);
              if (arr[si] && arr[di] && transferAffixes(arr[si], arr[di])) render();
            });
          }
          const tgBtn = cb.querySelector('button[data-cast-tg]');
          if (tgBtn && !tgBtn._bound) {
            tgBtn._bound = true;
            tgBtn.addEventListener('click', function () {
              const want = cb.querySelector('select[data-cast-want]').value;
              const slot = cb.querySelector('select[data-cast-slot]').value;
              if (targetForge(slot, 3, want)) render();
            });
          }
        }

        // 训话
        const sp = document.getElementById('speechBox');
        const sn = document.getElementById('speechNow');
        if (sn) {
          const pr = SPEECH_PRESETS[SECT_DOCTRINE.preset] || SPEECH_PRESETS.balanced;
          sn.textContent = pr.name + ' · 换装门槛 ×' + (1 + speechMargin()).toFixed(2);
        }
        // ★ 议事堂 · 打法倾向（R180/R54）
        //   🐞 R61 修两个问题（用户报"标题写偏攻、高亮的却是均衡"）：
        //     ① 原来每帧无条件 `bb.innerHTML = hb` ⇒ 战斗中每秒重建 60 次。
        //        真实鼠标"按下→抬起"只要跨过一次重建，浏览器就把 click 派发到
        //        【公共祖先 #biasBox】，按钮上的监听器永远收不到 ⇒ 点了没反应 / 看着状态不一致。
        //        ⇒ 改用 setDedup（内容没变就不碰 DOM），并把监听器改成【容器委托一次】，
        //          这样即使将来内容变了重建，事件也不会丢。
        //     ② 标题（#biasNow）与高亮必须来自同一个值 —— 现在共用 curBias。
        const bb = document.getElementById('biasBox');
        const bn = document.getElementById('biasNow');
        const curBias = BIAS[SECT_DOCTRINE.bias] || BIAS.bal;
        if (bn) bn.textContent = curBias.name;
        if (bb) {
          if (!bb._delegated) {
            bb._delegated = true;
            bb.addEventListener('click', function (ev) {
              const t = ev.target && ev.target.closest ? ev.target.closest('button[data-bias]') : null;
              if (!t) return;
              if (setBias(t.getAttribute('data-bias'))) render();
            });
          }
          let hb = '<div class="sp-row">';
          for (const k of Object.keys(BIAS)) {
            hb += '<button data-bias="' + k + '" class="' + (SECT_DOCTRINE.bias === k ? 'on' : '') +
              '" title="' + BIAS[k].desc + '">' + BIAS[k].name + '</button>';
          }
          hb += '</div><div style="font-size:10px;color:var(--dim2);margin-top:6px;line-height:1.7">' +
            curBias.desc + '</div>';
          setDedup(bb, hb);
        }
        // ★ 议事堂 · 派遣历练（R55）：不点具体某人（名字是随机生成的，点了没意义）
        //   ⇒ 给【依据】，由游戏从最新一批新招弟子里挑
        const db = document.getElementById('dispatchBox');
        if (db) {
          const PICK = { any: '随缘', talent: '天赋最高', tier: '修为最高', linggen: '灵根最好' };
          const cur = ROSTER.pickBy || 'any';
          let hd = '<div class="sp-row">';
          for (const k of Object.keys(PICK)) {
            hd += '<button data-pick="' + k + '" class="' + (cur === k ? 'on' : '') + '">' + PICK[k] + '</button>';
          }
          hd += '</div>';
          const who = pickSuccessor();
          hd += '<div style="font-size:10px;color:var(--dim2);margin-top:6px;line-height:1.7">' +
            '下一代出门的会是：<b style="color:var(--gold);font-weight:400">' +
            (who ? who.name + (who.talentName ? '（' + who.talentName + '）' : '') : '（等下一批招徒）') +
            '</b><br>从最新一批新招弟子里按这个依据挑，名与天赋跟着他走。</div>';
          db.innerHTML = hd;
          db.querySelectorAll('button[data-pick]').forEach(function (b) {
            if (b._bound) return; b._bound = true;
            b.addEventListener('click', function () {
              ROSTER.pickBy = b.getAttribute('data-pick');
              log('✦ 议事堂定下派遣依据：' + (PICK[ROSTER.pickBy] || ''), 'ok');
              render();
            });
          });
        }
        if (sp) {
          let h4 = '<div class="sp-row">';
          for (const k of Object.keys(SPEECH_PRESETS)) {
            const pr = SPEECH_PRESETS[k];
            h4 += '<button data-sp="' + k + '" class="' + (SECT_DOCTRINE.preset === k ? 'on' : '') +
              '" title="' + pr.desc + '">' + pr.name + '</button>';
          }
          h4 += '</div>';
          const ax = [['survive', '保命'], ['train', '修行'], ['profit', '收益']];
          for (const [k, nm] of ax) {
            h4 += '<div class="sp-axis"><span>' + nm + '</span>' +
              '<input type="range" min="0" max="100" step="10" data-spax="' + k + '" value="' +
              SECT_DOCTRINE.speech[k] + '"><b>' + SECT_DOCTRINE.speech[k] + '</b></div>';
          }
          sp.innerHTML = h4;
          sp.querySelectorAll('button[data-sp]').forEach(function (b) {
            if (b._bound) return; b._bound = true;
            b.addEventListener('click', function () { setSpeech(b.getAttribute('data-sp')); render(); });
          });
          sp.querySelectorAll('input[data-spax]').forEach(function (r) {
            if (r._bound) return; r._bound = true;
            r.addEventListener('change', function () {
              SECT_DOCTRINE.speech[r.getAttribute('data-spax')] = parseInt(r.value, 10);
              SECT_DOCTRINE.preset = 'custom';
              render();
            });
          });
        }
        // ★★ Round 34：门规面板（训话的「上锁版」）
        //   用户决策："上锁吧" ⇒ 把训话某轴锁为门规，跨代保留 + 署名
        {
          const rb = document.getElementById("ruleBox");
          if (rb) {
            let h = "<div class=\"rl-hd\">门规 <span class=\"n\">" + ruleCount("positive") +
              "/" + RULE_CFG.MAX_RULES + "</span></div>";
            const has = SECT_DOCTRINE.rules.filter(function (r) { return r.kind === "positive"; });
            // 每条正门规 + 废规按钮
            for (const r of has) {
              h += "<div class=\"rl-row\"><span class=\"ax\">" + AXIS_NAME[r.axis] + "</span>" +
                "<span class=\"v\">" + r.value + "</span>" +
                "<span class=\"by\">第 " + r.bornGen + " 代 · " + (r.by || "") + " 立</span>" +
                "<button data-rdrop=\"" + r.id + "\" title=\"废除此规\">×</button></div>";
            }
            // 未立规的轴 ⇒ 给「立为门规」按钮
            const free = ["survive", "train", "profit"].filter(function (a) { return !ruleHasAxis(a); });
            if (free.length && ruleCount("positive") < RULE_CFG.MAX_RULES) {
              h += "<div class=\"rl-add\">立为门规：";
              for (const a of free) {
                h += "<button data-radd=\"" + a + "\">" + AXIS_NAME[a] + " " +
                  SECT_DOCTRINE.speech[a] + "</button>";
              }
              h += "</div>";
            }
            // 负门规（积弊）
            const negs = SECT_DOCTRINE.rules.filter(function (r) { return r.kind === "negative"; });
            for (const r of negs) {
              h += "<div class=\"rl-row neg\"><span class=\"ax\">积弊</span>" +
                "<span class=\"v\">避" + r.zone + "</span>" +
                "<span class=\"by\">" + (r.by || "") + "</span>" +
                "<button data-rlift=\"" + r.id + "\" title=\"破除积弊（耗荣誉 " +
                RULE_CFG.LIFT_COST + "）\">解</button></div>";
            }
            // 战死计数（预告负门规）
            const dz = Object.keys(SECT_DOCTRINE.deathByZone || {});
            if (dz.length) {
              h += "<div class=\"rl-note\">战死之处：" + dz.map(function (z) {
                return z + " ×" + SECT_DOCTRINE.deathByZone[z];
              }).join(" · ") + "（满 " + RULE_CFG.NEG_TRIGGER + " 次成积弊）</div>";
            }
            rb.innerHTML = h;
            rb.querySelectorAll("button[data-radd]").forEach(function (b) {
              b.addEventListener("click", function () {
                ruleAdd(b.getAttribute("data-radd")); render();
              });
            });
            rb.querySelectorAll("button[data-rdrop]").forEach(function (b) {
              b.addEventListener("click", function () {
                ruleDrop(b.getAttribute("data-rdrop")); render();
              });
            });
            rb.querySelectorAll("button[data-rlift]").forEach(function (b) {
              b.addEventListener("click", function () {
                ruleLift(b.getAttribute("data-rlift")); render();
              });
            });
          }
        }
        // 门装模板
        const tm = document.getElementById('tmplBox');
        if (tm) {
          let h5 = '';
          for (const s of Object.keys(SLOT_ZONE)) {
            const w = SECT_DOCTRINE.want[s] || {};
            h5 += '<div class="tm-row"><span class="nm">' + s + '</span>';
            for (const ax of TEMPLATE_AXES) {
              h5 += '<select data-tm="' + s + '|' + ax + '">' +
                TEMPLATE_LEVELS.map(function (lv, i) {
                  return '<option value="' + i + '"' + ((w[ax] || 2) === i ? ' selected' : '') + '>' + lv + '</option>';
                }).join('') + '</select>';
            }
            h5 += '<span class="ax">' + (SLOT_MAIN[s] || '') + '</span></div>';
          }
          tm.innerHTML = h5;
          tm.querySelectorAll('select[data-tm]').forEach(function (sel) {
            if (sel._bound) return; sel._bound = true;
            sel.addEventListener('change', function () {
              const parts = sel.getAttribute('data-tm').split('|');
              SECT_DOCTRINE.want[parts[0]] = SECT_DOCTRINE.want[parts[0]] || {};
              SECT_DOCTRINE.want[parts[0]][parts[1]] = parseInt(sel.value, 10);
            });
          });
        }
      }

      // ★ 擂台战报（异步 PVP · 复盘）
      //   红线（设计规格_PVP.md §6）：只指出问题，不给答案。
      //   禁止出现"建议/推荐/应该换成"这类字样。
      {
        const pb = document.getElementById('pvpBox');
        if (pb) {
          const lg = PVP.lastLog || [];
          pb.innerHTML = lg.length ? lg.map(function (r) {
            const cls = r.rank === '胜' ? 'ok' : (r.rank === '惜败' ? 'warn' : 'bad');
            const diff = r.opp - r.mine;
            return '<div class="lg ' + cls + '" style="border-bottom:1px solid #ffffff0f;padding:5px 0">' +
              '<b style="font-weight:400">' + r.rank + '</b>' +
              '<span style="flex:1;color:#7e7768;font-size:10.5px">' + (r.place || '擂台') +
              ' · 我方 <b style="font-weight:400;color:#cfc8ba">' + r.mine + '</b>' +
              ' vs ' + (r.oppName || '无名') + ' <b style="font-weight:400;color:#cfc8ba">' + r.opp + '</b>' +
              ' <span style="color:' + (diff > 0 ? '#c0604f' : '#63b394') + '">' +
              (diff > 0 ? '▲' + diff : '▼' + (-diff)) + '</span>' +
              ' <span style="color:#5d574c">' + (r.oppBuild || '') + '</span></span></div>';
          }).join('') : '<div style="font-size:10px;color:#5d574c;padding:6px 0">（还没有打过擂台）</div>';
        }
        const ps = document.getElementById('pvpStat');
        if (ps) {
          const tot = (PVP.wins || 0) + (PVP.losses || 0);
          ps.textContent = tot ? (PVP.wins + ' 胜 / ' + PVP.losses + ' 负' +
            (PVP.streak >= 3 ? ' · 连胜中' : PVP.streak <= -3 ? ' · 连败中' : '')) : '';
        }
      }

      // ★ 传承池（可花荣誉点提取）+ 历代弟子图鉴（Round 13）
      {
        // ★ Round 27（用户要求）：宝库处置策略 —— 玩家留下指示，挂机按指示执行
        //   "由玩家来决定到底是当素材，还是给后面的弟子用，又或者当耗材分解，
        //    当然玩家不在的时候就根据玩家留下的指示来判断"
        {
        // ★ Round 30：重新开始（用户："话说我现在这个档要怎么从来啊"）
        {
          const rb = document.getElementById('resetBox');
          if (rb) {
            const rawh = '<div class="rs-hd">重新开始</div>' +
              '<div class="rs-warn">⚠️ 清空后【所有】进度都会消失：弟子 / 宗门 / 宝库 / 装备 / 功法</div>' +
              '<div class="rs-row">' +
                '<button id="btnExport" class="rs-alt">导出存档（备份）</button>' +
                '<button id="btnReset">重新开始</button>' +
              '</div>';
            if (setDedup(rb, rawh)) {
              const be = rb.querySelector('#btnExport');
              if (be) be.addEventListener('click', function () {
                const ok = exportSave();
                if (!ok) log('没有可导出的存档', 'warn');
                render();
              });
              const br = rb.querySelector('#btnReset');
              if (br) {
                br._armed = false;
                br.addEventListener('click', function () {
                  if (!br._armed) {
                    // 第一次点：进入待确认（3 秒后自动恢复）
                    br._armed = true;
                    br.textContent = '⚠️ 再点一次确认清档';
                    br.classList.add('armed');
                    render();
                    setTimeout(function () {
                      if (br._armed) { br._armed = false; br.textContent = '重新开始';
                        br.classList.remove('armed'); render(); }
                    }, 3000);
                  } else {
                    log('正在清空存档并重新开始…', 'warn');
                    hardReset();
                  }
                });
              }
            }
          }
        }
        
          const vb = document.getElementById('vaultPolicyBox');
          if (vb) {
            let _vh = '<div class="vp-hd">宝库处置（按品质）</div>';
            for (const q of [4, 3, 2, 1, 0]) {
              const cur = VAULT.policy[q] || 'hold';
              _vh += '<div class="vp-row"><span class="q" style="color:' + (QCOLOR[q] || '#888') + '">' +
                QUALITIES[q] + '</span>' +
                VAULT_MODES.map(function (m) {
                  return '<button data-vq="' + q + '" data-vm="' + m.id + '"' +
                    (cur === m.id ? ' class="on"' : '') + '>' + m.name + '</button>';
                }).join('') + '</div>';
            }
            const s = VAULT.stat;
            _vh += '<div class="vp-stat">累计：传家 ' + s.keep + ' · 拆素材 ' + s.mat +
              ' · 换荣誉 ' + s.honor + ' · 保留 ' + s.hold + '</div>';
            vb.innerHTML = _vh;
            vb.querySelectorAll('button[data-vq]').forEach(function (b) {
              b.addEventListener('click', function () {
                const q = parseInt(b.getAttribute('data-vq'), 10);
                const m = b.getAttribute('data-vm');
                VAULT.policy[q] = m;
                const r = vaultSettle();          // ★ 改完立刻按新策略处置一遍
                log('宝库策略：' + QUALITIES[q] + ' → ' + VAULT_MODE_BY_ID[m].name +
                  (r.mat ? ' · 拆了 ' + r.mat + ' 件' : '') + (r.honor ? ' · 换了 ' + r.honor + ' 件' : ''), 'sys');
                render();
              });
            });
          }
        }

        const pl = document.getElementById('poolList');
        if (pl) {
          if (!SECT.legacyPool.length) {
            pl.innerHTML = '<div style="font-size:10px;color:#5d574c;padding:6px 0">（传承池为空）</div>';
          } else {
            pl.innerHTML = SECT.legacyPool.slice(0, 12).map(function (it, i) {
              const cost = legacyPullCost(it);
              const can = SECT.honor >= cost;
              const nm = itemName(it);
              // ★ Round 25：神话可加【徽记】（禁止后人穿出去）
              const banned = SECT.legacyBan && SECT.legacyBan[it.id];
              const sealBtn = (it.q >= SECT.legacyBanQ)
                ? '<button class="seal-b" data-seal="' + i + '" title="' +
                  (banned ? '已封印：不可直传给后人' : '点此封印：禁止后人穿出去') + '">' +
                  (banned ? '🔒' : '🔓') + '</button>'
                : '';
              return '<div class="pool-it' + (banned ? ' sealed' : '') + '">' +
                '<span class="nm" style="color:' + (QCOLOR[it.q] || '#888') + '" title="' +
                (QUALITIES[it.q] || '') + ' ' + nm + ' ilvl' + Math.round(it.ilvl || 0) + '">' +
                nm + ' <span style="color:#5d574c">' + (QUALITIES[it.q] || '') + '</span></span>' +
                sealBtn +
                '<button data-pull="' + i + '"' + (can ? '' : ' disabled') + '>' + cost + '</button></div>';
            }).join('');
            if (SECT.legacyPool.length > 12) {
              // ★ Round 24 修复：原来是 `pl.innerHTML += ...`
              //   ⚠️ `+=` 会把【已有 HTML 重新解析一遍】⇒ 已渲染的结构被复制
              //      表现为用户看到的"优先列表重复好几组"
              //   ⇒ 改为【一次拼好再赋值】（见上面的 _h 变量）
              pl.insertAdjacentHTML('beforeend',
                '<div style="font-size:10px;color:#5d574c;padding:4px 0">…还有 ' +
                (SECT.legacyPool.length - 12) + ' 件</div>');
            }
            pl.querySelectorAll('button[data-pull]').forEach(function (b) {
              if (b._bound) return; b._bound = true;
              b.addEventListener('click', function () {
                if (pullFromPool(parseInt(b.getAttribute('data-pull'), 10))) render();
              });
            });
          }
        }
        const gl2 = document.getElementById('genList');
        if (gl2) {
          const hist = SECT.history.slice(-8).reverse();
          const CAUSE = { old_age: '善终', battle: '战死', handover: '主动交接' };
          gl2.innerHTML = hist.length ? hist.map(function (h) {
            const now = (h.gen === SECT.generation);
            return '<div class="lg" style="border-bottom:1px solid #ffffff0f;padding:5px 0' +
              (now ? ';color:#c9a227' : '') + '">' +
              '<b style="font-weight:400;color:' + (now ? '#e0c464' : '#9a9284') + '">第 ' + h.gen + ' 代</b>' +
              '<span style="flex:1;color:#7e7768;font-size:10.5px">' + (CAUSE[h.cause] || h.cause || '') +
              ' · 峰值 ' + (h.tier + 1) + ' 档' + (h.carried ? ' · 带回 ' + h.carried + ' 件' : '') +
              (h.lost ? ' · 遗落 ' + h.lost + ' 件' : '') + '</span></div>';
          }).join('') : '<div style="font-size:10px;color:#5d574c;padding:6px 0">（还没有完成的弟子）</div>';
        }
      }

      // ★ 宗门（局外层 · Round 13）
      const scb = document.getElementById("sectBox");
      if (scb) {
        const sb = sectBonus();
        const rk = SECT_RANKS[SECT.rank];
        const nxt = SECT_RANKS[SECT.rank + 1];
        // ★★ Round 48：这一段改成【当前宗门 buff】
        //   用户："如果有其他入口就把这里的删了，然后这里主要显示当前宗门buff（比如余韵什么的）"
        //   理由：4 个有建筑的升级项（传功阁/传承殿/宝库/延寿丹房）已经在各自建筑页里能升
        //         ⇒ 这里删掉，改成显示"现在到底有哪些加成在生效"
        //   ⚠️ 保留一个例外：入门礼（fac:null，没有自己的建筑）—— 删了就没地方升
        //      但要放到后面，且标注清楚
        let html2 = '<div class="sc-head"><span class="rank">' + rk.n +
          '</span><span class="honor">荣誉 ' + SECT.honor +
          (nxt ? '（距 ' + nxt.n + ' 还差 ' + Math.max(0, nxt.need - SECT.honor) + '）' : '（已至顶阶）') +
          '</span></div>';

        // ---------- ① 传承给赠（含余韵倒计时）----------
        let _gs = [];
        try { _gs = giftStatus() || []; } catch (e) { _gs = []; }
        if (_gs.length) {
          for (const g of _gs) {
            const ph = g.phase === 1 ? '满效' : '折扣';
            const left = (g.left < 0) ? '常驻' : (Math.round(g.left) + ' 息');
            html2 += '<div class="sc-buff"><b>' + g.name + '</b>' +
              '<span class="v">×' + (Math.round(g.power * 100) / 100) + ' · ' + ph + '</span>' +
              '<span class="t">余韵 ' + left + '</span></div>';
          }
        }

        // ---------- ② 后勤驻宗产出（来自岗位上的弟子）----------
        try {
          const _bl = backlineBonus();
          const _rows2 = [];
          if (_bl.qi > 1.001) _rows2.push(['修炼', '×' + (Math.round(_bl.qi * 100) / 100)]);
          if (_bl.mats > 0) _rows2.push(['素材', '+' + Math.round(_bl.mats) + '/届']);
          if (_bl.gf > 1.001) _rows2.push(['功法掉落', '×' + (Math.round(_bl.gf * 100) / 100)]);
          if (_bl.drop > 1.001) _rows2.push(['装备掉落', '×' + (Math.round(_bl.drop * 100) / 100)]);
          if (_bl.ilvl > 0.01) _rows2.push(['传承品级', '+' + (Math.round(_bl.ilvl * 10) / 10)]);
          if (_bl.info > 1.001) _rows2.push(['秘境情报', '×' + (Math.round(_bl.info * 100) / 100)]);
          if (_rows2.length) {
            html2 += '<div class="sc-sec">后勤驻宗</div>';
            for (const [k2, v2] of _rows2) html2 += '<div class="sc-buff"><b>' + k2 + '</b><span class="v">' + v2 + '</span></div>';
          }
        } catch (e) { }

        // ---------- ③ 宗门加成（已买等级的汇总）----------
        const _ups = SECT_UPGRADES.filter(function (u) { return (SECT.up[u.id] || 0) > 0; });
        if (_ups.length) {
          html2 += '<div class="sc-sec">宗门加成</div>';
          for (const u of _ups) {
            const lv = SECT.up[u.id] || 0;
            html2 += '<div class="sc-buff"><b>' + u.name + '</b>' +
              '<span class="lv">Lv' + lv + '/' + u.max + '</span>' +
              '<span class="v">' + u.desc(lv) + '</span></div>';
          }
        } else if (!_gs.length) {
          html2 += '<div class="sc-buff none">尚无宗门加成 —— 点地图上的建筑可以花荣誉升级</div>';
        }

        // ---------- ④ 提前交接留下的灵气启动金 ----------
        if (PENDING_QI > 0) {
          html2 += '<div class="sc-buff"><b>灵气启动金</b><span class="v">+' +
            Math.round(PENDING_QI) + '（下一代起手）</span></div>';
        }

        // ---------- ⑤ 入门礼（唯一没有建筑的升级项 —— 只能在这里升）----------
        for (const u of SECT_UPGRADES) {
          // ⚠️ 必须用 u.fac 查（SECT_UP_BY_FAC 的【键是设施 id】）
          //   原来写 SECT_UP_BY_FAC[u.id] —— u.id 是升级项 id
          //   （'slot'/'free' 的设施是 'legacy'/'vault'），两者只有部分重合
          //   ⇒ 传承殿/宝库 漏过滤，在"宗门加成"汇总和"可升级项"里各出现一次
          if (u.fac && SECT_UP_BY_FAC[u.fac] === u) continue;   // 有建筑的已在各自建筑页
          const lv = SECT.up[u.id] || 0;
          const cost = sectUpCost(u.id);
          const locked = SECT.rank < u.rank;
          const can = !locked && lv < u.max && SECT.honor >= cost;
          const btn = (lv >= u.max) ? '满' : (locked ? SECT_RANKS[u.rank].n : (cost + ' 荣誉'));
          html2 += '<div class="sc-up">' +
            '<span class="nm">' + u.name + '</span>' +
            '<span class="lv">Lv' + lv + '/' + u.max + '</span>' +
            '<span class="dsc">' + (lv ? u.desc(lv) : u.desc(1)) + '</span>' +
            '<button data-sc="' + u.id + '"' + (can ? '' : ' disabled') + '>' + btn + '</button></div>';
        }
        scb.innerHTML = html2;
        scb.querySelectorAll("button[data-sc]").forEach(function (btn) {
          if (btn._bound) return; btn._bound = true;
          btn.addEventListener("click", function () {
            if (buySectUpgrade(btn.getAttribute("data-sc"))) render();
          });
        });
      }

      // ================= 宗门地图（建筑热点 + 功能面板） =================
      {
        const mapEl = document.getElementById("sectMap");
        const imgEl = document.getElementById("sectMapImg");
        const spotsEl = document.getElementById("sectSpots");
        if (mapEl && imgEl && spotsEl) {
          // 阶位 → 图片档（用户定案：0/1 素 · 2/3 金顶 · 4 仙门）
          const tier = SECT.rank <= 1 ? 1 : (SECT.rank <= 3 ? 2 : 3);
          const IMGNAME = { 1: "宗门_档1_素", 2: "宗门_档2_金顶", 3: "宗门_档3_仙门" }[tier];
          if (SECT_MAP_TIER !== tier) {
            SECT_MAP_TIER = tier;
            // 用属性赋值（不用 setAttribute）—— 测试桩只实现了属性/样式
            imgEl.src = "assets/宗门/" + IMGNAME + ".webp";
            imgEl.srcset = "assets/宗门/" + IMGNAME + "@2x.webp 2x";
          }
          // 阶位滤镜 class
          for (let i = 0; i <= 4; i++) mapEl.classList.toggle("r" + i, i === SECT.rank);
          // 热点（只在建筑数变化时重建；位置固定）
          if (spotsEl.childElementCount !== SECT_MAP.length) {
            spotsEl.innerHTML = SECT_MAP.map(function (b) {
              // ★ Round 50：宗门大殿已是正式设施（arch）⇒ 标签统一取 FACILITIES 的名字
              const f = FAC_BY_ID[b.fac];
              const label = f ? f.name : ARCHIVE_NAME;
              // 朱色描边留给【宗门大殿】（档案性质，不是可升级设施）
              // tag-b：y 很小的热点（顶上那排）标签改放下方，否则被 overflow 裁掉
              const cls = 'spot' + (b.fac === ARCHIVE_FAC ? ' arch' : '') +
                          (b.y < 14 ? ' tag-b' : '');
              return '<div class="' + cls + '" data-b="' + b.fac + '" style="left:' +
                b.x + '%;top:' + b.y + '%;width:' + b.w + '%;height:' + b.h + '%">' +
                '<span class="ring"></span>' +
                '<span class="tag">' + label + '</span></div>';
            }).join('');
            spotsEl.querySelectorAll(".spot").forEach(function (s) {
              s.addEventListener("mouseenter", function () {
                SECT_SEL = s.getAttribute("data-b"); renderSectPanel();
              });
              s.addEventListener("click", function () {
                SECT_SEL = s.getAttribute("data-b");
                // ★ Round 42/50：点建筑 ⇒ 整页替换成该设施页
                //   ⚠️ 原来这里写死 isArch ⇒ 固定打开【藏经阁】（Round 44 的遗留，
                //      当时史册馆挂在藏经阁）。Round 45 把 ARCHIVE_FAC 改成 arch 之后
                //      没跟着改 ⇒ 点【宗门大殿】进的却是藏经阁，显示"功法研究"
                //      （用户报："宗门大殿里面怎么是功法研究"）
                openFacility(s.getAttribute("data-b"));
              });
            });
          }
          // 高亮当前选中
          spotsEl.querySelectorAll(".spot").forEach(function (s) {
            s.classList.toggle("on", s.getAttribute("data-b") === SECT_SEL);
          });
          renderSectPanel();
        }
      }

      const fbb = document.getElementById("fabaoBox");
      if (fbb) {
        const tdv = st.td || { level: 0, value: 0, same: 0, sheng: 0, ke: 0, mul: 1 };
        // ★ Round 24（用户选 B）：法宝面板【只显示已装的那 1 个】
        //   其余已拥有的收进"切换"列表（默认折叠）
        //   用户原话："法宝选b"
        const owned = FABAO.filter(function (f) { return FB_OWNED[f.id]; });
        const eqId = FB.eq[0];
        const eqF = eqId ? FABAO_BY_ID[eqId] : null;
        const condOf = function (f) {
          return f.cond === "hp" ? ("血≤" + Math.round(f.condN * 100) + "%")
            : f.cond === "crisis" ? ("怪≥" + f.condN)
            : f.cond === "kill" ? ("杀≥" + f.condN)
            : f.cond === "period" ? ("每" + f.condN + "次出手") : "精英出现";
        };
        let _fb = '';
        if (eqF) {
          _fb += "<div class=\"fb-slot\"><span class=\"lb\">已装</span>" +
            "<span class=\"nm on\" data-fbid=\"" + eqF.id + "\" title=\"" + eqF.desc + "（点击卸下）\">" +
            ico("fb", eqF.name, "ico20") + eqF.name +
            "<span class=\"wx\" style=\"color:" + (WX_COLOR[eqF.wx] || "#888") + "\">" +
            eqF.wx + "</span> · " + condOf(eqF) + "（本源 " + eqF.cost + "）</span></div>";
        } else {
          _fb += "<div class=\"fb-slot\"><span class=\"lb\">已装</span>" +
            "<span style=\"color:#5d574c\">（空 —— 掉落法宝后自动装上）</span></div>";
        }
        const others = owned.filter(function (f) { return f.id !== eqId; });
        if (others.length) {
          _fb += "<details class=\"fb-swap\"><summary>切换法宝（另有 " + others.length +
            " 件）</summary>" +
            others.map(function (f) {
              // ★ R66：催动条件的进度条（与 fbTriggered 的 ctx 同源）
              const _fbp = fbProgress(f);
              const _fbTxt = _fbp === null ? '' : '（进度 ' + Math.round(_fbp * 100) + '%）';
              return "<div class=\"fb-row\"><span class=\"nm\" data-fbid=\"" + f.id +
                "\" title=\"" + f.desc + _fbTxt + "\">" + ico("fb", f.name, "ico20") + f.name +
                "<span class=\"wx\" style=\"color:" + (WX_COLOR[f.wx] || "#888") + "\">" + f.wx +
                "</span> · " + condOf(f) + "（本源 " + f.cost + "）" +
                (_fbp === null ? '' : '<i class="pg' + (_fbp >= 1 ? ' rdy' : '') +
                  '" style="--c:' + (WX_COLOR[f.wx] || '#c9a227') + '"><b style="width:' +
                  (_fbp * 100).toFixed(1) + '%"></b></i>') + "</span></div>";
            }).join('') + "</details>";
        } else if (owned.length === 0) {
          _fb += "<div style=\"color:#5d574c;font-size:10px\">尚未拥有法宝（掉落获得）</div>";
        }
        // ★ Round 24：与 gb 同理 —— 法宝面板用稳定子容器 + 各自去重
        //   否则展开的「切换法宝」<details> 会被每帧重建收起
        if (!fbb._built) {
          const _fm = document.createElement('div'); _fm.className = 'fb-main';
          if (typeof fbb.replaceChildren === 'function') fbb.replaceChildren();
          else fbb.innerHTML = '';
          fbb.appendChild(_fm);
          fbb._fbMain = _fm; fbb._built = true;
        }
        const _fbMain = fbb._fbMain;
        const _fbstacks = "同调 " + tdv.level + " 级 · 值 " + tdv.value +
          "（同源 " + tdv.same + " 相生 " + tdv.sheng + " 相克 " + tdv.ke +
          (tdv.signBonus ? " 签名 +" + tdv.signBonus : "") +
          "） ⇒ 伤害 ×" + tdv.mul.toFixed(2);
        const _fbh = "<div style=\"color:#66708a;font-size:10px\">法宝 · 限 " + FABAO_SLOTS + " 个</div>" +
          _fb +
          "<div class=\"fb-stack\">" + _fbstacks + "</div>";
        if (setDedup(_fbMain, _fbh)) {
          _fbMain.querySelectorAll(".nm[data-fbid]").forEach(function (el) {
            el.addEventListener("click", function () {
              fbEquip(el.getAttribute("data-fbid"));
              log("法宝变更：" + (FB.eq.join("、") || "空"), "sys");
              render();
            });
          });
        }
        // 「道具位」占位（内容固定 ⇒ 只写一次）
        if (!fbb._itemSlots) {
          fbb._itemSlots = document.createElement('div');
          fbb._itemSlots.className = 'fb-stack fb-item-slots';
          fbb._itemSlots.style.color = '#4a5568';
          fbb._itemSlots.textContent = '道具位 □□ （设计待定）';
          fbb.appendChild(fbb._itemSlots);
        }
      }
    }
  }

  // ★ Round 44：设施页打开时刷新它的升级区
  if (typeof FAC_OPEN !== 'undefined' && FAC_OPEN && FAC_SEL) {
    try { renderFacilityUpgrade(FAC_SEL); } catch (e) { }
  }

  // ★ 史册馆（Round 38）：打开时随 render 刷新（否则停在史册页时宗门变化看不到）
  if (typeof ARCHIVE_OPEN !== "undefined" && ARCHIVE_OPEN) {
    try { renderArchiveBody(); } catch (e) { }
  }

  // ★★ 生平（Round 43 重做：按【代】归类）
  //
  //   用户："就像正常网游一个横幅播报一下，保存到史册馆的生平就行，
  //         史册馆的生平记得有归类喔，毕竟有很多代历练弟子，每代都该有自己的生平"
  //
  //   来源两块：
  //     ① SECT.chronicle[代]  —— 已故弟子的生平快照（持久化，进存档）
  //     ② G.log 当前代        —— 正在历练的这一代（内存，实时）
  //   显示：最近 5 代，新的在上；每代一个标题 + 该代记录
  if ($('#logBox')) {
    const CAUSE2 = { old_age: '善终', battle: '战死秘境', handover: '主动交接' };
    const gens = Object.keys(SECT.chronicle).map(Number).sort(function (a, b2) { return b2 - a; });
    const cur = SECT.generation;
    const show = gens.slice(0, 5);
    // 当前代也列出来（如果还没死）
    if (show.indexOf(cur) < 0 && G.log.some(function (l) { return l.gen === cur; })) show.unshift(cur);

    let html = '';
    if (!show.length) {
      html = '<div class="arc-empty">还没有生平记录。<br>' +
        '弟子在秘境里做的事（突破 / 得宝 / 渡劫 / 结仇）都会按代记在这里。</div>';
    } else {
      for (const g of show) {
        const rec = SECT.history.find(function (x) { return x.gen === g; });
        const rows = (g === cur)
          ? G.log.filter(function (l) { return l.gen === g; }).slice(0, 14)
          : (SECT.chronicle[g] || []).slice().reverse();
        // 代标题
        let sub = (g === cur) ? '正在历练' : (rec ? (CAUSE2[rec.cause] || rec.cause || '') : '');
        if (rec) {
          sub += ' · 峰值 ' + ((rec.tier | 0) + 1) + ' 档' +
            (rec.runs ? ' · ' + rec.runs + ' 局' : '') +
            (rec.carried ? ' · 带回 ' + rec.carried + ' 件' : '') +
            (rec.lost ? ' · 遗落 ' + rec.lost + ' 件' : '');
        }
        html += '<div class="arc-hd" style="margin-top:8px">' + genLab(g) +
          (rec && rec.name ? ' · ' + rec.name : '') + ' <em>' + sub + '</em></div>';
        if (rec) html += '<div class="bio-vol">' + bioVol(rec) + '</div>';
        if (!rows.length) {
          html += '<div class="arc-empty">（这一代没有留下记录）</div>';
        } else {
          html += '<details class="bio-raw"><summary>原始记录</summary>';
          for (const l of rows) {
            const msg = String(l.msg || '').replace(/<[^>]*>/g, '');
            html += '<div class="lg ' + (l.cls || '') + '">' + msg + '</div>';
          }
          html += '</details>';
        }
      }
    }
    $('#logBox').innerHTML = html;
  }
  // 素材
  const mEl = $('#mats');
  if (mEl) mEl.textContent = SECT_RES.materials;
}

// ★ 第 3 层「一眼可比」：显示"换上去之后"的六项变化
function renderCompare() {
  const box = $('#cmpBox');
  if (!box) return;
  const it = G.compare;
  if (!it || G.bag.indexOf(it) < 0) {
    box.innerHTML = '<div class="dim" style="padding:6px">鼠标移到背包物品上看变化</div>';
    return;
  }
  const ev = evaluateSwap(it);
  const rows = [
    ['攻击', ev.delta.atk, 0],
    ['生命', ev.delta.hp, 0],
    ['防御', ev.delta.def, 0],
    ['出手/秒', ev.delta.actFreq, 2],
    ['AOE', ev.delta.aoe, 0],
    ['承压阈值', ev.delta.thresh, 0],
  ];
  let html = `<div class="cmp-hd">
      <b style="color:${QCOLOR[it.q]}">${QUALITIES[it.q]}${it.name ? '·' + it.name : it.slot}</b>
      <span class="dim">${it.kind}+${it.mainVal} · ${it.shape[0]}×${it.shape[1]}</span>
    </div>`;
  html += '<table class="cmp-t">';
  for (const [name, dv, dec] of rows) {
    const v = dec ? dv.toFixed(dec) : Math.round(dv);
    const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'same';
    const sign = v > 0 ? '+' : '';
    html += `<tr><td>${name}</td><td class="${cls}">${v === 0 ? '—' : sign + v}</td></tr>`;
  }
  html += '</table>';
  // 放哪（或放不下）
  if (ev.bestZone) {
    const off = ev.bestZone !== it.home;
    html += `<div class="cmp-ft">放到 <b>${ev.bestZone}</b>` +
      (off ? ` <span class="warn">（错位：主属性 ×${(offzone(it.slot, ev.bestZone).keep * 100).toFixed(0)}%，` +
        `转换属性 ×${(offzone(it.slot, ev.bestZone).keep * offzone(it.slot, ev.bestZone).cmul * 100).toFixed(0)}%）</span>`
        : ` <span class="dim">（本位区，满额）</span>`) +
      `</div>`;
  } else {
    html += `<div class="cmp-ft"><span class="down">装不下（分区容量已满）</span></div>`;
  }
  box.innerHTML = html;
}

// ★ 自动找【最优位置】穿上（不是第一个塞得下的位置）
function bestEquip(idx) {
  const it = G.bag[idx];
  if (!it) return;
  const ev = evaluateSwap(it);
  // 允许穿上即使综合值略降（玩家可能为某个属性牺牲）——但必须装得下
  const cur = buildFingerprint();
  const pack = packLayout(cur, it);
  const mine = pack.placed.find(p => p.id === it.id);
  if (!mine) { log('装不下：所有分区容量已满', 'warn'); return; }
  const curIds = new Set(cur.map(x => x.id));
  const added = pack.placed.filter(p => !curIds.has(p.id));
  const removed = cur.filter(c => !pack.placed.some(p => p.id === c.id));
  // 清空重放（用装箱结果重建）
  initZones();
  for (const p of pack.placed) {
    const zc = G.zones[p._placedZone];
    const [w, h] = p.shape;
    outer:
    for (let y = 0; y <= zc.h - h; y++) for (let x = 0; x <= zc.w - w; x++) {
      if (canPlace(p, p._placedZone, x, y)) { place(p, p._placedZone, x, y); break outer; }
    }
  }
  // 把被替换下来的装备放回背包
  for (const r of removed) G.bag.push(Object.assign({}, r, { _gain: null, _new: false }));
  G.bag.splice(G.bag.indexOf(it), 1);
  const dz = mine._placedZone;
  log('穿上 ' + itemNameQ(it) + ' → ' + dz +
    (dz !== it.home ? '（错位）' : '') +
    (ev.gain > 0.005 ? ' 综合 ▲' + (ev.gain * 100).toFixed(0) + '%'
      : ev.gain < -0.005 ? ' 综合 ▼' + (-ev.gain * 100).toFixed(0) + '%' : ''),
    ev.gain > 0.005 ? 'ok' : ev.gain < -0.005 ? 'warn' : 'sys');
  G.compare = null;
  render();
}

// 分解单件
function scrapAt(idx) {
  const it = G.bag[idx];
  if (!it) return;
  const v = disenchantValue(it);
  G.bag.splice(idx, 1);
  SECT_RES.materials += v; G.disenchanted++;
  log('分解 ' + itemNameQ(it) + ' → 素材 +' + v, 'sys');
  render();
}

// 自动装备：找第一个能放下的区
function autoEquip(idx) {
  const it = G.bag[idx];
  if (!it) return;
  const order = [it.home, ...Object.keys(G.zones).filter(z => z !== it.home)];
  for (const z of order) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      if (canPlace(it, z, x, y)) {
        place(it, z, x, y);
        G.bag.splice(idx, 1);
        log('装备 ' + itemNameQ(it) + ' → ' + z + (z === it.home ? '（本位区）' : '（错位）'),
            z === it.home ? 'ok' : 'warn');
        render(); return;
      }
    }
  }
  log('没有能放下它的位置', 'warn');
}

// ---------------- 八、UI 绑定 ----------------
function buildUI() {
  // 分区面板
  const wrap = $('#zones');
  // ★ Round 38 防御：容器缺失时【跳过而不是崩】。
  //   教训：index.html 里 #zones 缺失 ⇒ wrap=null ⇒ wrap.appendChild 抛错
  //   ⇒ boot() 整个中断 ⇒ 白屏 + 顶部一句 "Cannot read properties of null"。
  //   容器缺失属于"HTML 与 JS 不同步"，该降级跳过，不该让游戏起不来。
  if (!wrap) {
    if (typeof console !== 'undefined') {
      console.warn('[buildUI] 找不到 #zones —— 跳过装备分区面板（HTML 与 JS 不同步？）');
    }
    return;
  }
  // ★ 装 · 经络图：6 个部位格分别放左右两栏（顺序按人体位置）
  const LAYOUT = [
    { z: '头',   side: 'left' },
    { z: '双手', side: 'left' },
    { z: '手臂', side: 'left' },
    { z: '躯干', side: 'right' },
    { z: '背',   side: 'right' },
    { z: '双腿', side: 'right' },
  ];
  for (const L of LAYOUT) {
    const z = L.z;
    const d = document.createElement('div');
    d.className = 'ztile ' + L.side;
    d.id = 'zone-' + z;
    // ★ 显式建子元素并持有引用
    //   不要用 d.innerHTML = '...' 然后再 querySelector：
    //   因为 render() 会清空容器，querySelector 就找不到了（曾因此白屏）
    const hd = document.createElement('div'); hd.className = 'zh';
    const grid = document.createElement('div'); grid.className = 'zg';
    d.appendChild(hd); d.appendChild(grid);
    d._hd = hd; d._grid = grid;
    wrap.appendChild(d);
  }
}
$('#btnRun')?.addEventListener('click', () => { if (!G.running) startRun(); });
// ★ 境 · 弟子数据控件（展开/收起）
// ★★ Round 40：境页两个功能入口
//   用户："境有几个按键，一个可以开背包…另一个可以查看当前弟子的各项数据"
//   ⚠️ 境页【不放弟子名册】——"这东西是宗门才该有的"
let BAG_OPEN = false;
function setBagOpen(on) {
  BAG_OPEN = !!on;
  const d = document.getElementById('bagDrawer');
  const b = document.getElementById('btnBag');
  if (d) d.classList.toggle('on', BAG_OPEN);
  if (b) b.classList.toggle('on', BAG_OPEN);
  if (BAG_OPEN) { try { render(); } catch (e) { } }
}
$('#btnBag')?.addEventListener('click', function () { setBagOpen(!BAG_OPEN); });
$('#btnCloseBag')?.addEventListener('click', function () { setBagOpen(false); });


// ★ Round 41：史册馆返回（回到宗门全景）
$('#btnArchiveBack')?.addEventListener('click', function () { openArchive(false); });

// ★★ Round 42：设施页的按钮监听（函数已移到模块级）
$('#btnFacBack')?.addEventListener('click', closeFacility);

// 史册 / 生平 切换（原来靠底部「录」页签，现在并进宗页）
$('#arcTabHis')?.addEventListener('click', function () {
  const a = document.getElementById('archiveBox'), l = document.getElementById('logBox');
  if (a) a.style.display = ''; if (l) l.style.display = 'none';
  document.getElementById('arcTabHis')?.classList.add('on');
  document.getElementById('arcTabLog')?.classList.remove('on');
});
$('#arcTabLog')?.addEventListener('click', function () {
  const a = document.getElementById('archiveBox'), l = document.getElementById('logBox');
  if (a) a.style.display = 'none'; if (l) l.style.display = '';
  document.getElementById('arcTabLog')?.classList.add('on');
  document.getElementById('arcTabHis')?.classList.remove('on');
});

// ★★ Round 40：宗页弟子名册 → 点某人跳到境页看他的数据（【单向】）
//   用户："弟子名册可以跳转到当前外出历练的弟子，但是不能反向"
//   ⚠️ 名册里大多是后勤弟子 ⇒ 点他们【不改动前线归属】，只是把"查看对象"临时指向他
function viewDisciple(id) {
  // ★ Round 49：弟子面板已删（用户："境页面这里显示的和当前弟子里面不是一样的吗"）
  //   面板独有的信息（头像/名字/灵根/天赋/暴击/本局进度）已并进 #hud
  //   ⇒ 宗页名册点击改成：跳到境页 + 横幅提示（前端弟子的数据就在 HUD 里）
  const d = ROSTER.list.find(function (v) { return v.id === (id | 0); });
  VIEW_DISC_ID = (id === null || id === undefined) ? null : (id | 0);
  if (typeof goTab === 'function') goTab('jing');
  if (!d) return;
  const f = ROSTER.front;
  if (f && d.id === f.id) {
    banner('当前历练：<b>' + d.name + '</b> · 数据见下方属性栏', 'ok');
  } else {
    // 后勤弟子没有实时战斗数值 ⇒ 只报身份
    banner('宗门在册：<b>' + d.name + '</b> · ' + (ROLES[d.role] || '') +
      ' · ' + (d.talentName || '') + ' · 寿元 ' + Math.round(d.lifespanDue == null ? d.lifespanLeft : d.lifespanDue) + ' 年', 'sys');
  }
}
document.addEventListener('click', function (e) {
  const row = e.target && e.target.closest ? e.target.closest('#rosterBox .rs-row[data-rid]') : null;
  if (!row) return;
  const id = parseInt(row.getAttribute('data-rid'), 10);
  if (id) viewDisciple(id);
});
window.__setBagOpen = setBagOpen;
window.__viewDisciple = viewDisciple;
$('#btnFast')?.addEventListener('click', () => { for (let i = 0; i < 120 && G.running; i++) tickN(1); });
// ★ 一键穿上所有"有提升"的
$('#btnEquipAll')?.addEventListener('click', () => {
  let n = 0, guard = 0;
  while (guard++ < 120) {
    let best = null, bi = -1;
    for (let i = 0; i < G.bag.length; i++) {
      const it = G.bag[i];
      const g = evaluateSwap(it).gain;      // ★ 用构建提升（不是同部位比较）
      if (g > 0.005 && (!best || g > best)) { best = g; bi = i; }
    }
    if (bi < 0) break;
    const before = G.bag.length;
    bestEquip(bi);
    if (G.bag.length < before) n++; else break;
  }
  log('一键穿上 ' + n + ' 件（只装提升的）', 'ok');
  render();
});
// ★ 一键分解所有"无提升"的
$('#btnScrap')?.addEventListener('click', () => {
  let n = 0, mats = 0;
  for (let i = G.bag.length - 1; i >= 0; i--) {
    const it = G.bag[i];
    const g = it._gain != null ? it._gain : upgradeDelta(it).ratio;
    if (g <= 0.005) { mats += disenchantValue(it); G.bag.splice(i, 1); n++; G.disenchanted++; }
  }
  SECT_RES.materials += mats;
  log('分解 ' + n + ' 件无提升装备 → 素材 +' + mats, 'sys');
  render();
});
// 过滤控件
$('#fltQ')?.addEventListener('change', e => {
  G.filterQ = parseInt(e.target.value) || 0;
  log('自动分解阈值 → ' + (G.filterQ === 0 ? '关闭' : QUALITIES[G.filterQ] + ' 以下'), 'sys');
});
$('#fltUp')?.addEventListener('change', e => { G.onlyUpgrade = e.target.checked; render(); });
$('#sortBy')?.addEventListener('change', e => { G.sortsBy = e.target.value; render(); });
$('#btnExtract')?.addEventListener('click', () => { extractNow(); });
$('#legacyRule')?.addEventListener('change', e => {
  A_setRule(e.target.value);
});
$('#btnCloseRp')?.addEventListener('click', () => {
  const rp = document.getElementById('reportPanel');
  if (rp) rp.style.display = 'none';
  G._seenAt = Date.now();       // 标记已读
  G._offlineShown = true;
  G.facYield = null;            // ★ 本期各部产出清零（下次报告只看新的一段）
  G._lastReportShow = Date.now();
});
$('#btnClear')?.addEventListener('click', () => {
  // ★ 全部卸下 ⇒ 放回背包（原来直接丢弃，装备会消失）
  const back = [];
  for (const z of Object.keys(G.zones)) {
    const zc = G.zones[z];
    for (let y = 0; y < zc.h; y++) for (let x = 0; x < zc.w; x++) {
      const c = zc.cells[y][x];
      if (c && c._anchor) back.push(Object.assign({}, c, { _anchor: undefined, _new: false, _gain: null }));
    }
  }
  initZones();
  for (const b of back) G.bag.push(b);
  log("已卸下全部装备（" + back.length + " 件放回背包）", "sys");
  render();
});

function A_tdOf(st) { return st && st.td ? st.td : { level: 0, value: 0, same: 0, sheng: 0, ke: 0, mul: 1 }; }

function A_setRule(k) {
  LEGACY_RULE.key = k;
  ev('rule', 3, { k });
  log('传承优先度 → ' + LEGACY_RULES[k].name, 'sys');
}

// ---------------- 九、自动循环（挂机核心） ----------------
// 每 200ms 推进一步（每次推 5 个 0.1s 步 = 0.5 秒游戏时间）
// ⇒ 一局 300 秒约需 120 秒真实时间
let LOOP = null;
function startLoop() {
  if (LOOP) return;
  LOOP = setInterval(() => {
    try {
      if (G.running) tick();
      else render();
    } catch (e) {
      console.error(e);
      showErr('主循环异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n'));
      clearInterval(LOOP); LOOP = null;
    }
  }, 200);
}

// ---------------- 十、初始化（带错误可视化） ----------------
function showErr(msg) {
  try {
    const b = document.getElementById('bootErr');
    if (b) { b.style.display = 'block'; b.textContent = '运行出错：\n' + msg; }
  } catch (_) {}
}


// ---------------- 三之二·二十七、重新开始（Round 30）----------------
//
// 用户："话说我现在这个档要怎么从来啊" —— 之前界面上【根本没有重开入口】
//
// 设计：
//   · 两步确认（第一次点变"确认清档"，3 秒内再点才真清）—— 防误触
//   · 清 localStorage 后 location.reload() ⇒ 所有内存状态从零初始化
//     （比重置几十个全局变量更安全，不会漏）
function hardReset() {
  // ★ 先立旗：阻止 beforeunload / visibilitychange / 定时器把旧档写回
  globalThis.__DSH_RESETTING = true;
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { }
  // 再清一次（防御：万一有别的地方刚写过）
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { }
  try { location.reload(); } catch (e) { }
}
// 导出存档（备份用）
function exportSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY) || '';
    if (!raw) return false;
    // 复制到剪贴板（失败则弹提示让玩家手动复制）
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(raw);
      log('已复制存档到剪贴板（' + Math.round(raw.length / 1024) + ' KB）', 'ok');
      return true;
    }
    log('存档内容已打印到控制台（F12 复制）', 'sys');
    console.log(raw);
    return true;
  } catch (e) { return false; }
}
function boot() {
  try {
    buildUI();
    sfxInit();                     // ★ R60：音效（默认关闭；开关状态从 localStorage 恢复）
    log('秘境录 · 挂机刷宝原型', 'sys');
    log('拖动背包装备到身体分区即可穿戴', 'sys');
    // ★ 先尝试读档；没有存档才新建第 1 代弟子
    //   （之前这里漏了 newDisciple ⇒ 第一个"弟子"寿元为 0 ⇒ 开局就报"寿元耗尽"）
    const loaded = loadGame();
    if (loaded) {
      const off = applyOffline();
      G._offline = off;
      if (off) {
        log('☾ 离线 ' + (off.away / 3600).toFixed(1) + ' 小时 · 击杀 ' + off.kills +
          ' · 灵气 +' + off.qi + ' · 素材 +' + (off.drops * P.OFFLINE_MATERIAL_PER_DROP), 'ok');
        if (off.died) setTimeout(() => { endDisciple('old_age'); render(); }, 500);
      } else {
        log('已读取存档 · ' + genLab(SECT.generation) + '弟子 · ' + P.REALMS[realm()], 'ok');
      }
    } else {
      newDisciple([makeSlotItem('主手', 6, 1, 'sword')]);
    }
    G._lastTick = Date.now();      // 初始化计时，避免首帧大跳变
    const sel = document.getElementById('legacyRule');
    if (sel) sel.value = LEGACY_RULE.key;
    G._seenAt = Date.now();        // 报告从"现在"开始看，开局不弹历史
    render();
    startLoop();
    startRun();          // 自动开打（挂机感）
  } catch (e) {
    showErr(e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
    console.error(e);
  }
}

// ★ 自动存档：切后台/关闭页面时保存（否则关掉就丢）
if (typeof window !== 'undefined' && window.addEventListener) {
  // ★ R67：切后台/回前台 —— 记录离开时刻 + 存档；回来时【按真实时间结算】
  //   为什么需要：浏览器对不可见标签页节流定时器（后台 ≥1 次/秒、长时间后台更狠），
  //   而 tick() 每次固定推进 0.5 游戏秒 ⇒ 后台其实在龟速跑，旧代码对这种短时离开完全不补。
  window.addEventListener('visibilitychange', () => {
    if (globalThis.__DSH_RESETTING) return;
    if (document.hidden) { G._bgAt = Date.now(); saveGame(); }
    else { try { settleBackground(); render(); } catch (e) { } }
  });
  window.addEventListener('beforeunload', () => { if (!globalThis.__DSH_RESETTING) saveGame(); });
  setInterval(function () { if (!globalThis.__DSH_RESETTING) saveGame(); }, 30000);
}

// 双保险：DOM 已就绪就直接跑，否则等事件
if (typeof document !== 'undefined') {
  const ready = () => { try { boot(); } catch (e) { showErr('boot 异常：' + e.message); } };
  if (document.readyState === 'loading' && typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('DOMContentLoaded', ready);
  } else {
    // 脚本在 body 末尾：此时 DOM 通常已就绪
    ready();
  }
}

// 暴露给测试
globalThis.__G = G;
globalThis.__P = P;
globalThis.__api = {
  makeItem, playerStats, canPlace, place, removeFromZone, unequipAt, autoEquip,
  startRun, step, tickN, endRun, initZones, offzone, itemPower, zoneCap, boot, render,
  evaluateSwap, upgradeDelta, equippedInSlot, makeSlotItem, isLegalItem, packLayout,
  dmgMul, dangerPerMob, softEvade, mobHp, spawnMul, spawnStart, spawnPeak,
  itemRawValue, effIlvlFor, isCapped, LEGACY_MAX_ILVL,
  saveGame, loadGame, applyOffline, extractNow, legacyQiValue,
  GIFTS, grantGifts, tickGifts, giftStatus, giftPower, giftOn, legacySlots,
  WUXING, KE, SHENG, WX_COLOR, wxMul, WX_ZHENG, wxSelfCheck, wxRelOf, WX_REL,
  GONGFA, GF_BY_ID, GF_TYPES, GF, GF_KNOWN, grantGongfa, grantFabao, FB_OWNED,
  rollFabaoDrop, makeGongfaItem, makeFabaoItem, bagHas, gfOf, gfOn, gfEquip, gfResetRun, gfMods, gfOnSwing, gfOnKill, rollGongfaDrop,
  gfActiveList, gfPriority, gfMovePrio, gfReady, gfMarkUsed,
  TD_THRESH, TD_MUL, tdValue, tdMul, tdScoreFor, slotWuxing,
  FABAO, FABAO_BY_ID, FABAO_SLOTS, FB, fbEquip, fbResetRun, fbTriggered,
  AFFIXES, AFFIX_BY_ID, AFFIX_COUNT, AFFIX_QLV, softCapMul, SOFT_BUDGET_RATE, ITEM_SLOTS,
  SIGNATURES, SIGNATURE_BY_ID, SIGN_SAME_BONUS,
  AFFIX_WX_BONUS, affixPctOf, affixNegPct, affixHas, negHas, rollSignature, equippedSignatures, activeSignature, AFFIX_ILVL_RATE, affixValue, rollAffixes, affixMul, affixZones, AFFIX_ZONE_CAP, affixLabel, affixTitle,
  get GIFTS_ACTIVE() { return GIFTS_ACTIVE; },
  set GIFTS_ACTIVE(v) { GIFTS_ACTIVE = v; },
  get PENDING_QI() { return PENDING_QI; }, serItem, deserItem, serZones, deserZones, SAVE_KEY, LEGACY_RULE, LEGACY_RULES, legacyScore, pickLegacy, pickLegacy_old, toggleLegacyBan, legacyAllowed, SEARCH, startSearch, tickSearch, autoTakeFromPool, EVENTS, ev, idleReport,
  hardReset, exportSave, VAULT, VAULT_MODES, VAULT_MODE_BY_ID, vaultModeFor, vaultSettle, vaultMatValue, vaultHonorValue,
    autoLearnSpecs, autoPickGongfa, gfScore, autoPickSpecs,
  tick, tickN, startRun, endRun, gainQi, mobHp, qiNeed, newDisciple, endDisciple,
  FACILITIES, FAC_BY_ID, disciplePower, facOutput, backlineBonus, autoAssignPosts, grantBacklineOutput, TALENT_ORDER,
  SECT_UP_BY_FAC,
  ROSTER, ROLES, ASSIGN_RULES, baseRecruit, RECRUIT_BASE, RECRUIT_PER_LEVEL, ROSTER_CAP, totalSlots,
  makeDisciple, assignDisciple, recruit, settleBackline, backlineCost, generationalTurnover, rollTalentBySect,
  TALENTS, TAL, talOf, talReset, talSpeedMul, talLifeMul, LIFE_PER_REALM, LIFE_CAP_YEARS,
  lifeMaxYears, grantLifeOnRealm, jealousyMul, jealousyLabel, expectedYearsAt, livedYears,
  DUJIE, dujieReset, dujieRate, doDujie, dujieBaseRate, dujieDaoji, dujieLifeFactor, dujieQiMul, isRealmBreak,
  TRAIN, trainCost, trainStepCost, trainTotalCost, trainStartTier, trainUpgrade, trainNewDisciple,
  SECT_RES, FORGE_RECIPES, forge, forgeAll, forgeCost, canForge,
  setBagOpen, viewDisciple, BAG_OPEN,
  reforge, reforgeCost, transferAffixes, transferCost, targetForge, targetCost, targetPool,
  FORGE_BASE, affixScoreOf,
  SECT_DOCTRINE, doctrineReset, renderArchiveBody, openArchive, banner, snapshotChronicle,
  openFacility, closeFacility,
  get FAC_OPEN() { return FAC_OPEN; },
  get ARCHIVE_OPEN() { return ARCHIVE_OPEN; }, idleReportData, renderIdleReport, fmtClock, RULE_CFG, RULE_ROLL, AXIS_NAME,
  ruleAdd, ruleDrop, ruleLift, ruleCount, ruleHasAxis, ruleValue, ruleEffective, ruleNoteDeath, ruleRollReset, TEMPLATE_LEVELS, TEMPLATE_AXES, SPEECH_PRESETS, setSpeech, speechMargin,
  itemAxes, doctrineScore, assembleBest, autoScrapByDoctrine,
  SECT, SECT_RANKS, SECT_UPGRADES, ZONE_BIAS, ZB, zbNow, zbAdvance, zbReset, zbWeights, zbReason, sectPeers,
  ZB_W,
  LINGGEN, LG, lgOf, lgResetLinggen, lgQiMul, lgTdThreshMul, lgLabel, lgSet, lgMain, lgSub, lgMainLabel, WX_ALL,
  MOB_KINDS, MOB_KINDS_INVADE, MOB_KINDS_ELITE, mobTable, rollMobKind,
  EVENT, EV_CFG, EV_PLACES, evTickRun, evResetEvents,
  PVP, pvpFight, pvpMatch, pvpRecordSelf, pvpMakeSeed, pvpEnsureSeeds, pvpResetRun, pvpRandomName,
  combatPower, rivalPower, evRunTourney, tourneyBracket, tourneyAllowed, invadeActive, evYearNow, sectBonus, honorForDisciple, addHonor, refreshSectRank,
  sectUpCost, buySectUpgrade, legacyPullCost, pullFromPool, DISCIPLE, realm, realmOf, rollDrop, distToHero, threatsIn, wanderHero, crowdAvoidWeight, HERO_HOME_X, HERO_HOME_Y, WEAPONS, WEAPON_BY_ID, statsOfLayout, buildFingerprint, disenchantValue, scrapAt, bestEquip, DROP,
  ZONE_CAP, SHAPES, QUALITIES, P,
  // ★ R59：图标（供 _smoke.js 校验「每个 id 都有图 + 文件真的在盘上」）
  FAC_ICON, ICO_DIR, WEAPON_ICON, ico, TRAIT_RAR, TRAITS, TRAIT_BY_ID, rollTraits,
  // ★ R60：音效（供 _smoke.js 校验「映射不漏 + 文件在盘上 + 默认关闭 + 节流生效」）
  SFX, SFX_FILES, SFX_CFG, SFX_FORM, SFX_CORE, SFX_STORE_KEY, sfx, sfxSet, sfxOn, sfxWarm,
  // ★ R62：战斗表现层（特效原型 / 顿帧），供 _smoke.js 校验"没漏配、没冻数值"
  VFX, SKILL_ARCH, FABAO_ARCH, skillVfx, hitstop,
  // ★ R64：几何命中（武器扇面/溅射），供 _smoke.js 与 _tools/reach.js 用
  WPN_HIT, WPN_HIT_DEF, hitCandidates,
  // ★ R66：进度条（供 _smoke.js 校验"与真实触发同源"）
  gfProgress, fbProgress, GF_TYPE_COLOR, renderSkillBar,
  // ★ R67：离开结算（离线 / 后台共用一套公式）
  settleAway, applyOffline, settleBackground, CLOCK_RATIO,
};
