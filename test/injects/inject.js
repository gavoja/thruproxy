var div = document.createElement('div')
div.id = 'injected-with-js'
div.innerHTML = '<p>This text was injected from a JavaScript file.</p>'
document.body.insertBefore(div, document.querySelector('h1'))
