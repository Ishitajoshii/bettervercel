const button = document.getElementById('celebrate');
const status = document.getElementById('click-status');
let launches = 0;
button.disabled = false;
button.addEventListener('click', () => {
  launches += 1;
  status.textContent = `JavaScript is working! ${launches} ${launches === 1 ? 'celebration' : 'celebrations'} launched.`;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let index = 0; index < 20; index += 1) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    spark.setAttribute('aria-hidden', 'true');
    spark.style.left = `${10 + Math.random() * 80}vw`;
    spark.style.top = `${Math.random() * 20}vh`;
    spark.style.backgroundColor = ['#275d43', '#d2ad59', '#8caa70', '#e6be9d'][index % 4];
    spark.style.animationDelay = `${Math.random() * 200}ms`;
    document.body.append(spark);
    setTimeout(() => spark.remove(), 1800);
  }
});
