const demo = document.querySelector('[data-demo]')

if (demo) {
  const steps = [
    { image: './assets/demo-find-session.webp', caption: '01 / 统一入口，找到当前任务', alt: '步骤一：在 HHPI 的统一侧栏搜索和找到不同来源的会话；实际界面，演示数据' },
    { image: './assets/demo-workspace.webp', caption: '02 / 并排读上下文，分别写草稿', alt: '步骤二：HHPI 中并排打开两个对话窗格，各自展示对话历史与草稿输入区；实际界面，演示数据' },
    { image: './assets/demo-source-tools.webp', caption: '03 / 回到原来源，继续处理工作', alt: '步骤三：对话中的来源文件引用，以及展开的更多输入控件菜单；实际界面，演示数据' },
  ]
  const buttons = Array.from(demo.querySelectorAll('[data-step]'))
  const image = demo.querySelector('[data-demo-image]')
  const imageLink = demo.querySelector('[data-demo-image-link]')
  const fullLink = demo.querySelector('[data-demo-full]')
  const caption = demo.querySelector('[data-demo-caption]')
  const status = demo.querySelector('[data-demo-status]')
  const play = demo.querySelector('[data-demo-play]')
  const playLabel = demo.querySelector('[data-play-label]')
  let current = 0
  let timer = null

  function showStep(index, announce = true) {
    current = index
    const step = steps[index]
    image.src = step.image
    image.alt = step.alt
    imageLink.href = step.image
    fullLink.href = step.image
    caption.textContent = step.caption
    buttons.forEach((button, buttonIndex) => {
      button.classList.toggle('is-active', buttonIndex === index)
      button.setAttribute('aria-pressed', String(buttonIndex === index))
    })
    if (announce) status.textContent = step.caption
  }

  function pause() {
    clearInterval(timer)
    timer = null
    playLabel.textContent = '播放三步导览'
    play.setAttribute('aria-pressed', 'false')
    play.querySelector('.play-icon').textContent = '▷'
  }

  buttons.forEach((button, index) => {
    button.addEventListener('click', () => { pause(); showStep(index) })
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length
      buttons[next].focus()
      pause()
      showStep(next)
    })
  })

  play.hidden = false
  play.setAttribute('aria-pressed', 'false')
  play.addEventListener('click', () => {
    if (timer) { pause(); return }
    playLabel.textContent = '暂停导览'
    play.setAttribute('aria-pressed', 'true')
    play.querySelector('.play-icon').textContent = 'Ⅱ'
    timer = setInterval(() => {
      if (current === steps.length - 1) { pause(); return }
      showStep(current + 1, false)
    }, 3600)
    if (current === steps.length - 1) showStep(0)
  })
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause() })
  window.addEventListener('pagehide', pause)
}

if (navigator.clipboard?.writeText) {
  document.querySelectorAll('[data-copy]').forEach(button => {
    button.hidden = false
    button.addEventListener('click', async () => {
      const code = document.getElementById(button.dataset.copy)
      const status = document.querySelector('[data-copy-status]')
      try {
        await navigator.clipboard.writeText(code.textContent)
        button.textContent = '已复制'
        status.textContent = '命令已复制到剪贴板。'
      } catch {
        button.textContent = '请选取命令复制'
        status.textContent = '未能访问剪贴板，请选取代码中的命令并复制。'
      }
      setTimeout(() => { button.textContent = '复制' }, 2400)
    })
  })
}
