import { extend, options, typeNumber, emptyObject, isFn, returnFalse, returnTrue, clearArray } from "../src/util";
import { fiberizeChildren } from "./createElement";
import { drainQueue, enqueueUpdater } from "./scheduler";
import { pushError, captureError } from "./ErrorBoundary";
import { insertElement, document } from "./browser";
import { Refs } from "./Refs";

function alwaysNull() {
    return null;
}

/**
 * 将虚拟DOM转换为Fiber
 * @param {vnode} vnode 
 * @param {Fiber} parentFiber 
 */
export function ComponentFiber(vnode, parentFiber) {
    extend(this, vnode);
    var type = vnode.type;
    this.name = type.displayName || type.name;
    this.return = parentFiber;
    this.context = getMaskedContext(getContextProvider(parentFiber), type.contextTypes);
    this._reactInternalFiber = vnode;
    this._pendingCallbacks = [];
    this._pendingStates = [];
    this._states = [ "resolve" ];
    this._mountOrder = Refs.mountOrder++;

    //  fiber总是保存最新的数据，如state, props, context
    //  this._hydrating = true 表示组件会调用render方法及componentDidMount/Update钩子
    //  this._nextCallbacks = [] 表示组件需要在下一周期重新渲染
    //  this._forceUpdate = true 表示会无视shouldComponentUpdate的结果
}

ComponentFiber.prototype = {
    addState: function(state) {
        var states = this._states;
        if (states[states.length - 1] !== state) {
            states.push(state);
        }
    },
    transition(updateQueue) {
        var state = this._states.shift();
        if (state) {
            this[state](updateQueue);
        }
    },
    enqueueSetState(state, cb) {
        if (state === true) {
            //forceUpdate
            this._forceUpdate = true;
        } else {
            //setState
            this._pendingStates.push(state);
        }
        if (this._hydrating) {
            //组件在更新过程（_hydrating = true），其setState/forceUpdate被调用
            //那么会延期到下一个渲染过程调用
            if (!this._nextCallbacks) {
                this._nextCallbacks = [ cb ];
            } else {
                this._nextCallbacks.push(cb);
            }
            return;
        } else {
            if (isFn(cb)) {
                this._pendingCallbacks.push(cb);
            }
        }
        if (document.__async) {
            //在事件句柄中执行setState会进行合并
            enqueueUpdater(this);
            return;
        }
        if (this._isMounted === returnTrue) {
            if (this._receiving) {
                //componentWillReceiveProps中的setState/forceUpdate应该被忽略
                return;
            }
            this.addState("hydrate");
            drainQueue([ this ]);
        }
    },
    mergeStates() {
        let instance = this.stateNode,
            pendings = this._pendingStates,
            n = pendings.length,
            state = instance.state;
        if (n === 0) {
            return state;
        }
        let nextState = extend({}, state); //每次都返回新的state
        for (let i = 0; i < n; i++) {
            let pending = pendings[i];
            if (pending && pending.call) {
                pending = pending.call(instance, nextState, this.props);
            }
            extend(nextState, pending);
        }
        pendings.length = 0;
        return nextState;
    },

    _isMounted: returnFalse,
    init(updateQueue, mountCarrier) {
        let { props, context, type, tag } = this,
            isStateless = tag === 1,
            instance,
            mixin;
        //实例化组件
        try {
            var lastOwn = Refs.currentOwner;
            if (isStateless) {
                instance = {
                    refs: {},
                    __proto__: type.prototype,
                    render: function() {
                        return type(this.props, this.context);
                    }
                };
                Refs.currentOwner = instance;
                mixin = type(props, context);
            } else {
                instance = new type(props, context);
                Refs.currentOwner = instance;
            }
        } catch (e) {
            //失败时，则创建一个假的instance
            instance = {
                updater: this
            };
            //  vnode.stateNode = instance;
            this.stateNode = instance;
            return pushError(instance, "constructor", e);
        } finally {
            Refs.currentOwner = lastOwn;
        }
        //如果是无状态组件需要再加工
        if (isStateless) {
            if (mixin && mixin.render) {
                //带生命周期的
                extend(instance, mixin);
            } else {
                //不带生命周期的
                this.child = mixin;
                this._isStateless = true;
                this.mergeStates = alwaysNull;
                this._willReceive = false;
            }
        }
		
        this.stateNode = instance;
        getDerivedStateFromProps(this, type, props, instance.state);
        //如果没有调用constructor super，需要加上这三行
        instance.props = props;
        instance.context = context;
        instance.updater = this;
        var carrier = this._return ? {} : mountCarrier;
        this._mountCarrier = carrier;
        this._mountPoint = carrier.dom || null;
        //this._updateQueue = updateQueue;
        if (instance.componentWillMount) {
            captureError(instance, "componentWillMount", []);
        }
        instance.state = this.mergeStates();
        //让顶层的元素updater进行收集
        this.render(updateQueue);
        updateQueue.push(this);
    },

    hydrate(updateQueue, inner) {
        let { stateNode: instance, context, props } = this;
        if (this._states[0] === "hydrate") {
            this._states.shift(); // ReactCompositeComponentNestedState-state
        }
        let state = this.mergeStates();
        let shouldUpdate = true;
        if (!this._forceUpdate && !captureError(instance, "shouldComponentUpdate", [ props, state, context ])) {
            shouldUpdate = false;

            var nodes = collectComponentNodes(this._children);
            var carrier = this._mountCarrier;
            carrier.dom = this._mountPoint;
            nodes.forEach(function(el) {
                insertElement(el, carrier.dom);
                carrier.dom = el.stateNode;
            });
        } else {
            captureError(instance, "componentWillUpdate", [ props, state, context ]);
            var { props: lastProps, state: lastState } = instance;
            this._hookArgs = [ lastProps, lastState ];
        }

        if (this._hasError) {
            return;
        }
	
        delete this._forceUpdate;
        //既然setState了，无论shouldComponentUpdate结果如何，用户传给的state对象都会作用到组件上
        instance.props = props;
        instance.state = state;
        instance.context = context;
        if (!inner) {
            this._mountCarrier.dom = this._mountPoint;
        }
		
        if (shouldUpdate) {
            this.render(updateQueue);
        }
        this.addState("resolve");
        updateQueue.push(this);
    },
    render(updateQueue) {
        let { stateNode: instance } = this,
            children = emptyObject,
            fibers = this._children || emptyObject,
            rendered,
            number;

        this._hydrating = true;
        //给下方使用的context
       
        if (instance.getChildContext) {
            var c = getContextProvider(this.return);
            c = getUnmaskedContext(instance, c);
            this._unmaskedContext = c;
        }
        
        if (this._willReceive === false) {
            rendered = this.child; //原来是vnode.child
            delete this._willReceive;
        } else {
            let lastOwn = Refs.currentOwner;
            Refs.currentOwner = instance;
            rendered = captureError(instance, "render", []);
            if (this._hasError) {
                rendered = true;
            }
            Refs.currentOwner = lastOwn;
        }
        number = typeNumber(rendered);
        if (number > 2) {
            children = fiberizeChildren(rendered, this);
        } else {
            //undefinded, null, boolean
            this._children = children; //emptyObject
            delete this.child;
        }
        Refs.diffChildren(fibers, children, this, updateQueue, this._mountCarrier);
    },
    // ComponentDidMount/update钩子，React Chrome DevTools的钩子， 组件ref, 及错误边界
    resolve(updateQueue) {
        let { stateNode: instance, _reactInternalFiber: vnode } = this;
        let hasMounted = this._isMounted();
        if (!hasMounted) {
            this._isMounted = returnTrue;
        }
        if (this._hydrating) {
            let hookName = hasMounted ? "componentDidUpdate" : "componentDidMount";
            captureError(instance, hookName, this._hookArgs || []);
            //执行React Chrome DevTools的钩子
            if (hasMounted) {
                options.afterUpdate(instance);
            } else {
                options.afterMount(instance);
            }
            delete this._hookArgs;
            delete this._hydrating;
        }

        if (this._hasError) {
            return;
        } else {
            //执行组件ref（发生错误时不执行）
            if (vnode._hasRef) {
                Refs.fireRef(this, instance, vnode);
                vnode._hasRef = false;
            }
            clearArray(this._pendingCallbacks).forEach(function(fn) {
                fn.call(instance);
            });
        }
        transfer.call(this, updateQueue);
    },
    catch(queue) {
        let { stateNode: instance } = this;
        // delete Refs.ignoreError;
        this._states.length = 0;
        this._children = {};
        this._isDoctor = this._hydrating = true;
        instance.componentDidCatch.apply(instance, this.errorInfo);
        delete this.errorInfo;
        this._hydrating = false;
        transfer.call(this, queue);
    },
    dispose() {
        let { stateNode: instance } = this;
        options.beforeUnmount(instance);
        instance.setState = instance.forceUpdate = returnFalse;

        Refs.fireRef(this, null, this._reactInternalFiber);
        captureError(instance, "componentWillUnmount", []);
        //在执行componentWillUnmount后才将关联的元素节点解绑，防止用户在钩子里调用 findDOMNode方法
        this._isMounted = returnFalse;
        this._disposed = true;
    }
};
function transfer(queue) {
    var cbs = this._nextCallbacks,
        cb;
    if (cbs && cbs.length) {
        //如果在componentDidMount/Update钩子里执行了setState，那么再次渲染此组件
        do {
            cb = cbs.shift();
            if (isFn(cb)) {
                this._pendingCallbacks.push(cb);
            }
        } while (cbs.length);
        delete this._nextCallbacks;
        this.addState("hydrate");
        queue.push(this);
    }
}
export function getDerivedStateFromProps(updater, type, props, state) {
    if (isFn(type.getDerivedStateFromProps)) {
        state = type.getDerivedStateFromProps.call(null, props, state);
        if (state != null) {
            updater._pendingStates.push(state);
        }
    }
}

export function getMaskedContext(curContext, contextTypes) {
    let context = {};
    if (!contextTypes || !curContext) {
        return context;
    }
    for (let key in contextTypes) {
        if (contextTypes.hasOwnProperty(key)) {
            context[key] = curContext[key];
        }
    }
    return context;
}

export function getUnmaskedContext(instance, parentContext) {
    let context = instance.getChildContext();
    if (context) {
        parentContext = extend(extend({}, parentContext), context);
    }
    return parentContext;
}
export function getContextProvider(fiber) {
    do {
        var c = fiber._unmaskedContext;
        if (c) {
            return c;
        }
    } while ((fiber = fiber.return));
}

//收集fiber
export function collectComponentNodes(children) {
    var ret = [];
    for (var i in children) {
        var child = children[i];
        var instance = child.stateNode;
        if (child._disposed) {
            continue;
        }
        if (child.tag > 4) {
            ret.push(child);
        } else {
            var fiber = instance.updater;
            if (child.child) {
                var args = collectComponentNodes(fiber._children);
                ret.push.apply(ret, args);
            }
        }
    }
    return ret;
}
//明天测试ref,与tests
