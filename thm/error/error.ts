

class THMError extends Error{
    file:string
    line:number
    message: string
    target:string
    location:string
    constructor(file:string,line:number,message:string,target:string,location:string="module"){
        super(message)
        this.file=file
        this.line=line
        this.message=message
        this.target=target
        this.location=location
        this.name="THMError"
        
    }
    to_str():string{
        let msg:string = "Traceback (most recent call last):\n"
        msg+=`File "${this.file}", line ${this.line}, in <${this.location}>\n`
        msg+= `\t${this.target}\n\t${'^'.repeat(this.target.length)}\n`
        msg+= `${this.name}: ${this.message}`
        return msg
    }
}
export class TokenizerError extends THMError{
    constructor(file:string,line:number,message:string,target:string,location:string="module"){
        super(file,line,message,target,location)
        this.name="TokenizerError"
    }
}

export class SyntaxError extends THMError{
    constructor(file:string,line:number,message:string,target:string,location:string="module"){
        super(file,line,message,target,location)
        this.name="SyntaxError"
    }
}

export class ValueError extends THMError{
    constructor(file:string,line:number,message:string,target:string,location:string="module"){
        super(file,line,message,target,location)
        this.name="ValueError"
    }
}