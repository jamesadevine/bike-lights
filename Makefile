all: deploy

build:
	pxt build

check:
	mkc build --java-script

deploy:
	pxt deploy

test:
	node --test tests/system.test.cjs
