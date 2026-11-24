// Production Docker installs omit Husky, so skip before importing it.
if (process.env.HUSKY !== '0') {
  const { default: husky } = await import('husky');
  const error = husky();
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
