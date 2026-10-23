import './style.css';

let count = 0;
const button = document.querySelector('#counter');
button.addEventListener('click', () => {
  button.textContent = `Test JavaScript · ${++count}`;
});
document.querySelector('#status').textContent = 'JavaScript loaded successfully';
