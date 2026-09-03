// The handlers a set of steps is meant to reach: the button really changes the
// document, and the message it shows goes away on its own, which is what a
// call's second section is written against.
const name = document.getElementById('machine-name')
const site = document.getElementById('machine-site')
const count = document.getElementById('added-count')
const rows = document.getElementById('fleet-rows')
const toast = document.getElementById('toast')
const trimmed = document.getElementById('trimmed')

document.getElementById('add-machine').addEventListener('click', () => {
  const added = Number(count.dataset.added ?? '0') + 1
  count.dataset.added = String(added)
  count.textContent = `Machines added: ${added}`
  const row = document.createElement('tr')
  const machine = document.createElement('td')
  machine.textContent = name.value
  const where = document.createElement('td')
  where.textContent = site.options[site.selectedIndex].text
  row.append(machine, where)
  rows.append(row)
  toast.textContent = `Added ${name.value}`
  toast.hidden = false
  setTimeout(() => {
    toast.hidden = true
    toast.textContent = ''
  }, 400)
})

// The page's own way of spelling a command: a class and nothing else. A step
// reaching this one carries the class tokens the read printed, because there is
// no name to carry. It says the same thing however many times it is pressed, so
// what the page ends up as does not depend on how the model split its calls.
document.querySelector('.el-icon-delete').addEventListener('click', () => {
  while (rows.children.length > 1) rows.lastElementChild.remove()
  trimmed.dataset.trimmed = '1'
  trimmed.textContent = 'Extra machines: cleared'
})

// Records that this document executed, so a spec can tell a live frame from a
// reloaded one: the counter restarts at 1 on every navigation of the frame.
window.__contentAppLoads = (window.__contentAppLoads ?? 0) + 1
